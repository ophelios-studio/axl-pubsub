import { matches } from "./topic-matcher.js";

export interface PeerEntry {
  pubkey: string;
  topics: string[];
  lastSeq: number;
  expiresAt: number;
}

export type UpsertResult =
  | { kind: "new"; topics: string[] }
  | { kind: "refreshed"; topics: string[] }
  | { kind: "changed"; prevTopics: string[]; topics: string[] }
  | { kind: "stale"; topics: string[] };

export interface SubscriptionTableOptions {
  now?: () => number;
}

export class SubscriptionTable {
  private readonly now: () => number;
  private readonly entries = new Map<string, PeerEntry>();

  constructor(opts: SubscriptionTableOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  upsert(ad: { from: string; topics: string[]; seq: number; ttlMs: number }): UpsertResult {
    this.evictExpired();
    const existing = this.entries.get(ad.from);
    if (existing && ad.seq <= existing.lastSeq) {
      return { kind: "stale", topics: existing.topics };
    }
    const expiresAt = this.now() + ad.ttlMs;
    if (!existing) {
      this.entries.set(ad.from, {
        pubkey: ad.from,
        topics: [...ad.topics],
        lastSeq: ad.seq,
        expiresAt,
      });
      return { kind: "new", topics: [...ad.topics] };
    }
    const prevTopics = existing.topics;
    const same = sameStringArray(prevTopics, ad.topics);
    existing.topics = [...ad.topics];
    existing.lastSeq = ad.seq;
    existing.expiresAt = expiresAt;
    return same
      ? { kind: "refreshed", topics: [...ad.topics] }
      : { kind: "changed", prevTopics, topics: [...ad.topics] };
  }

  peers(): PeerEntry[] {
    this.evictExpired();
    return [...this.entries.values()].map((e) => ({ ...e, topics: [...e.topics] }));
  }

  subscribersFor(topic: string): string[] {
    this.evictExpired();
    const out: string[] = [];
    for (const e of this.entries.values()) {
      if (e.topics.some((p) => matches(p, topic))) out.push(e.pubkey);
    }
    return out;
  }

  sweepExpired(): string[] {
    const t = this.now();
    const removed: string[] = [];
    for (const [k, v] of this.entries) {
      if (v.expiresAt <= t) {
        this.entries.delete(k);
        removed.push(k);
      }
    }
    return removed;
  }

  has(pubkey: string): boolean {
    this.evictExpired();
    return this.entries.has(pubkey);
  }

  size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  private evictExpired(): void {
    const t = this.now();
    for (const [k, v] of this.entries) {
      if (v.expiresAt <= t) this.entries.delete(k);
    }
  }
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
