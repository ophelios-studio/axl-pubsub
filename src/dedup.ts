export interface DedupOptions {
  windowMs: number;
  now?: () => number;
}

export class Dedup {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, number>();

  constructor(opts: DedupOptions) {
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
  }

  isFresh(from: string, id: string): boolean {
    const key = `${from}|${id}`;
    const t = this.now();
    this.evictExpired(t);
    if (this.entries.has(key)) return false;
    this.entries.set(key, t);
    return true;
  }

  size(): number {
    this.evictExpired(this.now());
    return this.entries.size;
  }

  private evictExpired(t: number): void {
    const cutoff = t - this.windowMs;
    for (const [k, v] of this.entries) {
      if (v >= cutoff) break;
      this.entries.delete(k);
    }
  }
}
