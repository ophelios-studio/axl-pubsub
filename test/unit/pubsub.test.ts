import { describe, expect, it } from "vitest";
import { PubSub } from "../../src/pubsub.js";
import { parseKeyPairFromPem } from "../../src/signing.js";

// Throwaway ed25519 keypair generated specifically for these tests.
// Never funded, never used outside this repo. Safe to expose publicly.
const PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIMpAWJ/6tD/Xu+KZO6+ouV+keSKlVxVljlMSUF+Wr2id
-----END PRIVATE KEY-----
`;
const SELF = "707c630a6f28cd368ab6fd4a9f66015bfccc742a004944337b198a94322e773c";

class MockAxlNode {
  private queue: { fromHeader: string; body: Uint8Array }[] = [];
  peers: string[] = [];
  sent: { dest: string; body: Uint8Array }[] = [];
  ourPubkey: string;

  constructor(ourPubkey: string) {
    this.ourPubkey = ourPubkey;
  }

  inject(fromHeader: string, body: Uint8Array) {
    this.queue.push({ fromHeader, body });
  }

  fetchImpl = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname === "/topology") {
      return new Response(
        JSON.stringify({
          our_ipv6: "200::1",
          our_public_key: this.ourPubkey,
          peers: this.peers.map((public_key) => ({ public_key })),
          tree: this.peers.map((public_key) => ({ public_key })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.pathname === "/send") {
      const headers = init?.headers as Record<string, string> | undefined;
      const dest = headers?.["X-Destination-Peer-Id"] ?? "";
      const body = new Uint8Array((init?.body as ArrayBuffer | Uint8Array) ?? new Uint8Array());
      this.sent.push({ dest, body });
      return new Response(null, { status: 200 });
    }
    if (url.pathname === "/recv") {
      const m = this.queue.shift();
      if (!m) return new Response(null, { status: 204 });
      return new Response(m.body, {
        status: 200,
        headers: { "X-From-Peer-Id": m.fromHeader },
      });
    }
    return new Response(null, { status: 404 });
  };
}

async function settle(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("PubSub validation", () => {
  it("rejects start() without keyPair or privateKeyPath", async () => {
    const node = new MockAxlNode(SELF);
    const ps = new PubSub({ axlUrl: "http://x", fetchImpl: node.fetchImpl });
    await expect(ps.start()).rejects.toThrow(/keyPair or privateKeyPath/);
  });

  it("publish() before start() throws", async () => {
    const kp = await parseKeyPairFromPem(PEM);
    const node = new MockAxlNode(SELF);
    const ps = new PubSub({ axlUrl: "http://x", keyPair: kp, fetchImpl: node.fetchImpl });
    await expect(ps.publish("a.b", new Uint8Array())).rejects.toThrow(/start/);
  });

  it("publish() with invalid concrete topic throws", async () => {
    const kp = await parseKeyPairFromPem(PEM);
    const node = new MockAxlNode(SELF);
    const ps = new PubSub({ axlUrl: "http://x", keyPair: kp, fetchImpl: node.fetchImpl });
    await ps.start();
    await expect(ps.publish("a.*", new Uint8Array())).rejects.toThrow(/concrete topic/);
    await ps.stop();
  });

  it("publish() rejects oversized payload", async () => {
    const kp = await parseKeyPairFromPem(PEM);
    const node = new MockAxlNode(SELF);
    const ps = new PubSub({
      axlUrl: "http://x",
      keyPair: kp,
      fetchImpl: node.fetchImpl,
      maxPayloadBytes: 10,
    });
    await ps.start();
    await expect(ps.publish("a.b", new Uint8Array(11))).rejects.toThrow(/too large/);
    await ps.stop();
  });

  it("subscribe() with invalid pattern throws", async () => {
    const kp = await parseKeyPairFromPem(PEM);
    const node = new MockAxlNode(SELF);
    const ps = new PubSub({ axlUrl: "http://x", keyPair: kp, fetchImpl: node.fetchImpl });
    await expect(ps.subscribe("a.#", () => {})).rejects.toThrow(/invalid topic pattern/);
  });
});

describe("PubSub flow", () => {
  it("publish with no known subscribers returns empty sentTo", async () => {
    const kp = await parseKeyPairFromPem(PEM);
    const node = new MockAxlNode(SELF);
    const ps = new PubSub({
      axlUrl: "http://x",
      keyPair: kp,
      fetchImpl: node.fetchImpl,
      pollIntervalMs: 5,
      advertiseIntervalMs: 100_000,
      peerSweepIntervalMs: 100_000,
    });
    await ps.start();
    const r = await ps.publish("news.test", new Uint8Array([1]));
    expect(r.sentTo).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.id).toBeTruthy();
    await ps.stop();
  });

  it("delivers a matching pub to a subscribed handler (self-loopback via inject)", async () => {
    const kp = await parseKeyPairFromPem(PEM);
    const node = new MockAxlNode(SELF);
    const ps = new PubSub({
      axlUrl: "http://x",
      keyPair: kp,
      fetchImpl: node.fetchImpl,
      pollIntervalMs: 5,
      advertiseIntervalMs: 100_000,
      peerSweepIntervalMs: 100_000,
    });
    await ps.start();
    const received: { topic: string; from: string; payload: string }[] = [];
    await ps.subscribe("news.*", (m) => {
      received.push({
        topic: m.topic,
        from: m.from,
        payload: new TextDecoder().decode(m.payload),
      });
    });
    const { encodePub } = await import("../../src/envelope.js");
    const bytes = await encodePub({
      topic: "news.test",
      payload: new TextEncoder().encode("hello"),
      keyPair: kp,
    });
    const fromHeader = `${SELF.slice(0, 28)}${"ff".repeat(18)}`;
    node.inject(fromHeader, bytes);
    await settle(40);
    await ps.stop();
    expect(received).toEqual([{ topic: "news.test", from: SELF, payload: "hello" }]);
  });
});
