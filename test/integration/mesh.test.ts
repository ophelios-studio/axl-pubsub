import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AxlClient } from "../../src/axl-client.js";
import { encodePub } from "../../src/envelope.js";
import { PubSub } from "../../src/pubsub.js";
import { type KeyPair, parseKeyPairFromPem } from "../../src/signing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = path.join(__dirname, "compose", "keys");
const NODES = {
  alice: "http://localhost:9002",
  bob: "http://localhost:9012",
  charlie: "http://localhost:9022",
};
const FAST = {
  pollIntervalMs: 25,
  advertiseIntervalMs: 200,
  subscriptionTtlMs: 1500,
  peerSweepIntervalMs: 200,
};

async function meshReachable(): Promise<boolean> {
  for (const url of Object.values(NODES)) {
    try {
      const r = await fetch(`${url}/topology`);
      if (!r.ok) return false;
      const t = (await r.json()) as { our_public_key?: string };
      if (!t.our_public_key) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function loadKey(name: string): Promise<KeyPair> {
  return parseKeyPairFromPem(readFileSync(path.join(KEYS_DIR, `${name}.pem`), "utf8"));
}

async function settle(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await settle(50);
  }
  throw new Error("waitFor timed out");
}

describe("integration mesh", () => {
  let aliceKp: KeyPair;
  let bobKp: KeyPair;
  let charlieKp: KeyPair;
  let alice: PubSub;
  let bob: PubSub;
  let charlie: PubSub;

  beforeAll(async () => {
    if (!(await meshReachable())) {
      throw new Error(
        "AXL mesh not reachable. Run: cd test/integration/compose && make up",
      );
    }
    aliceKp = await loadKey("alice");
    bobKp = await loadKey("bob");
    charlieKp = await loadKey("charlie");
  });

  beforeEach(async () => {
    alice = new PubSub({ axlUrl: NODES.alice, keyPair: aliceKp, ...FAST });
    bob = new PubSub({ axlUrl: NODES.bob, keyPair: bobKp, ...FAST });
    charlie = new PubSub({ axlUrl: NODES.charlie, keyPair: charlieKp, ...FAST });
    await Promise.all([alice.start(), bob.start(), charlie.start()]);
  });

  afterEach(async () => {
    await Promise.all([alice.stop(), bob.stop(), charlie.stop()]);
  });

  it("propagates a sub_ad to other nodes within seconds", async () => {
    await bob.subscribe("immunity.antibody.*", () => {});
    await waitFor(() => alice.knownPeers().some((p) => p.pubkey === bobKp.publicKeyHex));
    const entry = alice.knownPeers().find((p) => p.pubkey === bobKp.publicKeyHex);
    expect(entry?.topics).toContain("immunity.antibody.*");
  });

  it("delivers a published message to a matching subscriber with verified sender", async () => {
    const received: { topic: string; from: string; payload: string }[] = [];
    await bob.subscribe("news.test", (m) => {
      received.push({
        topic: m.topic,
        from: m.from,
        payload: new TextDecoder().decode(m.payload),
      });
    });
    await waitFor(() => alice.subscribersFor("news.test").length > 0);
    const result = await alice.publish("news.test", new TextEncoder().encode("hello"));
    expect(result.sentTo).toContain(bobKp.publicKeyHex);
    await waitFor(() => received.length > 0, 3000);
    expect(received[0]?.from).toBe(aliceKp.publicKeyHex);
    expect(received[0]?.topic).toBe("news.test");
    expect(received[0]?.payload).toBe("hello");
  });

  it("wildcard subscriber receives matching topics only", async () => {
    const received: string[] = [];
    await charlie.subscribe("news.*", (m) => {
      received.push(m.topic);
    });
    await waitFor(() => alice.subscribersFor("news.test").length > 0);
    await alice.publish("news.test", new Uint8Array([1]));
    await alice.publish("other.test", new Uint8Array([2]));
    await settle(500);
    expect(received).toEqual(["news.test"]);
  });

  it("rejects tampered envelopes via the 'error' event", async () => {
    const errors: Error[] = [];
    bob.on("error", (e: unknown) => errors.push(e as Error));
    const bytes = await encodePub({
      topic: "news.test",
      payload: new Uint8Array([0]),
      keyPair: charlieKp,
    });
    const json = JSON.parse(Buffer.from(bytes).toString("utf8"));
    json.topic = "news.tampered";
    const tampered = new TextEncoder().encode(JSON.stringify(json));
    const charlieClient = new AxlClient({ baseUrl: NODES.charlie });
    await charlieClient.send(bobKp.publicKeyHex, tampered);
    await waitFor(() => errors.some((e) => e.name === "EnvelopeError"), 3000);
  });

  it("evicts an absent peer after TTL and emits 'peer-left'", async () => {
    const left: string[] = [];
    bob.on("peer-left", (p: { pubkey: string }) => left.push(p.pubkey));
    await alice.subscribe("news.test", () => {});
    await waitFor(() => bob.knownPeers().some((p) => p.pubkey === aliceKp.publicKeyHex));
    await alice.stop();
    await waitFor(() => left.includes(aliceKp.publicKeyHex), 5000);
    expect(bob.knownPeers().some((p) => p.pubkey === aliceKp.publicKeyHex)).toBe(false);
  });
});
