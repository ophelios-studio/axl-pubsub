import type { AxlClient, Topology } from "./axl-client.js";
import { encodeSubAd } from "./envelope.js";
import type { KeyPair } from "./signing.js";

export interface AdvertiserOptions {
  client: Pick<AxlClient, "send" | "topology">;
  keyPair: KeyPair;
  intervalMs: number;
  ttlMs: number;
  getTopics: () => string[];
  onError?: (err: Error) => void;
}

export class Advertiser {
  private readonly opts: AdvertiserOptions;
  private seq = 0;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;

  constructor(opts: AdvertiserOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.trigger();
    this.timer = setInterval(() => this.trigger(), this.opts.intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inflight) await this.inflight;
  }

  async refresh(): Promise<void> {
    if (!this.running) return;
    if (this.inflight) await this.inflight;
    await this.advertise();
  }

  private trigger(): void {
    if (!this.running || this.inflight) return;
    this.inflight = this.advertise().finally(() => {
      this.inflight = null;
    });
  }

  private async advertise(): Promise<void> {
    this.seq += 1;
    const bytes = await encodeSubAd({
      topics: this.opts.getTopics(),
      seq: this.seq,
      ttlMs: this.opts.ttlMs,
      keyPair: this.opts.keyPair,
    });
    let topology: Topology;
    try {
      topology = await this.opts.client.topology();
    } catch (err) {
      this.reportError(err);
      return;
    }
    const peers = gatherPeers(topology);
    await Promise.all(
      peers.map(async (pk) => {
        try {
          await this.opts.client.send(pk, bytes);
        } catch (err) {
          this.reportError(err);
        }
      }),
    );
  }

  private reportError(err: unknown): void {
    this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}

function gatherPeers(topology: Topology): string[] {
  const set = new Set<string>();
  const self = topology.our_public_key;
  for (const p of topology.peers) if (p.public_key !== self) set.add(p.public_key);
  for (const p of topology.tree) if (p.public_key !== self) set.add(p.public_key);
  return [...set];
}
