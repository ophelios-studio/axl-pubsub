import { EventEmitter } from "node:events";
import { ulid } from "ulid";
import { Advertiser } from "./advertiser.js";
import { AxlClient } from "./axl-client.js";
import { Dedup } from "./dedup.js";
import { type DecodedPub, type DecodedSubAd, encodePub } from "./envelope.js";
import { Poller } from "./poller.js";
import { type KeyPair, loadKeyPairFromPem } from "./signing.js";
import { SubscriptionTable } from "./subscription-table.js";
import { isValidConcreteTopic, isValidPattern, matches } from "./topic-matcher.js";

export interface PubSubOptions {
  axlUrl: string;
  privateKeyPath?: string;
  keyPair?: KeyPair;
  pollIntervalMs?: number;
  advertiseIntervalMs?: number;
  subscriptionTtlMs?: number;
  dedupWindowMs?: number;
  peerSweepIntervalMs?: number;
  maxPayloadBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface ReceivedPub {
  topic: string;
  from: string;
  id: string;
  ts: number;
  payload: Uint8Array;
}

export type PubSubHandler = (msg: ReceivedPub) => void | Promise<void>;

export interface Subscription {
  pattern: string;
  unsubscribe(): Promise<void>;
}

export interface PublishResult {
  id: string;
  sentTo: string[];
  failed: { pubkey: string; error: Error }[];
}

const DEFAULTS = {
  pollIntervalMs: 25,
  advertiseIntervalMs: 30_000,
  subscriptionTtlMs: 90_000,
  dedupWindowMs: 60_000,
  peerSweepIntervalMs: 5_000,
  maxPayloadBytes: 16 * 1024 * 1024 - 1024,
};

export class PubSub extends EventEmitter {
  private readonly opts: PubSubOptions & typeof DEFAULTS;
  private readonly client: AxlClient;
  private readonly table = new SubscriptionTable();
  private readonly dedup: Dedup;
  private readonly handlers = new Map<string, Set<PubSubHandler>>();
  private keyPair: KeyPair | null = null;
  private poller: Poller | null = null;
  private advertiser: Advertiser | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(opts: PubSubOptions) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
    this.client = new AxlClient(
      opts.fetchImpl
        ? { baseUrl: opts.axlUrl, fetchImpl: opts.fetchImpl }
        : { baseUrl: opts.axlUrl },
    );
    this.dedup = new Dedup({ windowMs: this.opts.dedupWindowMs });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.keyPair = await this.resolveKeyPair();
    this.poller = new Poller({
      client: this.client,
      intervalMs: this.opts.pollIntervalMs,
      onMessage: (d, fh) => this.dispatch(d, fh),
      onError: (err) => this.emit("error", err),
    });
    this.advertiser = new Advertiser({
      client: this.client,
      keyPair: this.keyPair,
      intervalMs: this.opts.advertiseIntervalMs,
      ttlMs: this.opts.subscriptionTtlMs,
      getTopics: () => [...this.handlers.keys()],
      onError: (err) => this.emit("error", err),
    });
    this.poller.start();
    this.advertiser.start();
    this.sweepTimer = setInterval(() => this.sweep(), this.opts.peerSweepIntervalMs);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    await this.poller?.stop();
    await this.advertiser?.stop();
    this.poller = null;
    this.advertiser = null;
  }

  async subscribe(pattern: string, handler: PubSubHandler): Promise<Subscription> {
    if (!isValidPattern(pattern)) throw new Error(`invalid topic pattern: ${pattern}`);
    let set = this.handlers.get(pattern);
    if (!set) {
      set = new Set();
      this.handlers.set(pattern, set);
    }
    set.add(handler);
    if (this.started) await this.advertiser?.refresh();
    return {
      pattern,
      unsubscribe: async () => {
        const cur = this.handlers.get(pattern);
        if (!cur) return;
        cur.delete(handler);
        if (cur.size === 0) this.handlers.delete(pattern);
        if (this.started) await this.advertiser?.refresh();
      },
    };
  }

  async publish(topic: string, payload: Uint8Array): Promise<PublishResult> {
    if (!this.keyPair) throw new Error("PubSub.start() must be called before publish()");
    if (!isValidConcreteTopic(topic)) throw new Error(`invalid concrete topic: ${topic}`);
    if (payload.length > this.opts.maxPayloadBytes) {
      throw new Error(`payload too large: ${payload.length} > ${this.opts.maxPayloadBytes}`);
    }
    const subs = this.table.subscribersFor(topic);
    const id = ulid();
    const bytes = await encodePub({ topic, payload, keyPair: this.keyPair, id });
    const failed: { pubkey: string; error: Error }[] = [];
    const sentTo: string[] = [];
    await Promise.all(
      subs.map(async (pk) => {
        try {
          await this.client.send(pk, bytes);
          sentTo.push(pk);
        } catch (err) {
          failed.push({
            pubkey: pk,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }),
    );
    return { id, sentTo, failed };
  }

  knownPeers() {
    return this.table.peers();
  }

  subscribersFor(topic: string): string[] {
    return this.table.subscribersFor(topic);
  }

  private async resolveKeyPair(): Promise<KeyPair> {
    if (this.opts.keyPair) return this.opts.keyPair;
    if (this.opts.privateKeyPath) return loadKeyPairFromPem(this.opts.privateKeyPath);
    throw new Error("PubSub requires either keyPair or privateKeyPath");
  }

  private async dispatch(
    decoded: DecodedPub | DecodedSubAd,
    fromHeader: string,
  ): Promise<void> {
    if (!fromHeaderMatchesPubkey(fromHeader, decoded.from)) {
      this.emit(
        "error",
        new Error(`X-From-Peer-Id ${fromHeader} does not match envelope.from ${decoded.from}`),
      );
      return;
    }
    if (decoded.kind === "pub") return this.dispatchPub(decoded);
    return this.dispatchSubAd(decoded);
  }

  private async dispatchPub(p: DecodedPub): Promise<void> {
    if (!this.dedup.isFresh(p.from, p.id)) return;
    const msg: ReceivedPub = {
      topic: p.topic,
      from: p.from,
      id: p.id,
      ts: p.ts,
      payload: p.payload,
    };
    for (const [pattern, set] of this.handlers) {
      if (!matches(pattern, p.topic)) continue;
      for (const h of set) {
        try {
          await h(msg);
        } catch (err) {
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
  }

  private async dispatchSubAd(ad: DecodedSubAd): Promise<void> {
    const r = this.table.upsert({
      from: ad.from,
      topics: ad.topics,
      seq: ad.seq,
      ttlMs: ad.ttl_ms,
    });
    if (r.kind === "new") this.emit("peer-joined", { pubkey: ad.from, topics: ad.topics });
  }

  private sweep(): void {
    for (const pubkey of this.table.sweepExpired()) {
      this.emit("peer-left", { pubkey });
    }
  }
}

// X-From-Peer-Id is a Yggdrasil-IPv6-derived prefix of the sender's pubkey:
// trailing 0xff padding plus one mixed-bit byte at the boundary. Strip the
// trailing ff bytes, drop the last byte, prefix-compare the rest.
function fromHeaderMatchesPubkey(fromHeader: string, pubkeyHex: string): boolean {
  if (!fromHeader || !pubkeyHex) return false;
  let trimmed = fromHeader.toLowerCase();
  while (trimmed.length >= 2 && trimmed.slice(-2) === "ff") {
    trimmed = trimmed.slice(0, -2);
  }
  if (trimmed.length < 4) return false;
  const prefix = trimmed.slice(0, -2);
  return pubkeyHex.toLowerCase().startsWith(prefix);
}
