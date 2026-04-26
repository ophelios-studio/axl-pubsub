import type { AxlClient } from "./axl-client.js";
import { type Decoded, EnvelopeError, decode } from "./envelope.js";

export interface PollerOptions {
  client: Pick<AxlClient, "recv">;
  intervalMs: number;
  onMessage: (decoded: Decoded) => void | Promise<void>;
  onError: (err: Error) => void;
}

export class Poller {
  private readonly opts: PollerOptions;
  private running = false;
  private pumpPromise: Promise<void> | null = null;

  constructor(opts: PollerOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pumpPromise = this.pump();
  }

  async stop(): Promise<void> {
    this.running = false;
    const p = this.pumpPromise;
    this.pumpPromise = null;
    if (p) await p;
  }

  private async pump(): Promise<void> {
    while (this.running) {
      try {
        const msg = await this.opts.client.recv();
        if (!msg) {
          await sleep(this.opts.intervalMs);
          continue;
        }
        await this.handle(msg.body);
      } catch (err) {
        this.reportError(err);
        await sleep(this.opts.intervalMs);
      }
    }
  }

  private async handle(body: Uint8Array): Promise<void> {
    let decoded: Decoded;
    try {
      decoded = await decode(body);
    } catch (err) {
      if (err instanceof EnvelopeError) return this.reportError(err);
      throw err;
    }
    try {
      await this.opts.onMessage(decoded);
    } catch (err) {
      this.reportError(err);
    }
  }

  private reportError(err: unknown): void {
    this.opts.onError(err instanceof Error ? err : new Error(String(err)));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
