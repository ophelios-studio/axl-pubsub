import { describe, expect, it, vi } from "vitest";
import { Advertiser } from "../../src/advertiser.js";
import { decode } from "../../src/envelope.js";
import { parseKeyPairFromPem } from "../../src/signing.js";

// Throwaway ed25519 keypair generated specifically for these tests.
// Never funded, never used outside this repo. Safe to expose publicly.
const PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIMpAWJ/6tD/Xu+KZO6+ouV+keSKlVxVljlMSUF+Wr2id
-----END PRIVATE KEY-----
`;
const SELF = "707c630a6f28cd368ab6fd4a9f66015bfccc742a004944337b198a94322e773c";

function fakeTopology(extraPeers: string[]) {
  return {
    our_ipv6: "200::1",
    our_public_key: SELF,
    peers: extraPeers.map((public_key) => ({ public_key })),
    tree: [{ public_key: SELF }],
  };
}

async function settle(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Advertiser", () => {
  it("fan-outs a signed sub_ad to every non-self peer", async () => {
    const kp = await parseKeyPairFromPem(PEM);
    const peerA = "a".repeat(64);
    const peerB = "b".repeat(64);
    const send = vi.fn(async () => {});
    const client = {
      topology: vi.fn(async () => fakeTopology([peerA, peerB])),
      send,
    };
    const adv = new Advertiser({
      client,
      keyPair: kp,
      intervalMs: 10_000,
      ttlMs: 30_000,
      getTopics: () => ["news.*"],
    });
    adv.start();
    await settle(20);
    await adv.stop();
    expect(send.mock.calls.map((c) => c[0]).sort()).toEqual([peerA, peerB]);
    const body = send.mock.calls[0]?.[1] as Uint8Array;
    const decoded = await decode(body);
    expect(decoded.kind).toBe("sub_ad");
    if (decoded.kind !== "sub_ad") return;
    expect(decoded.topics).toEqual(["news.*"]);
    expect(decoded.from).toBe(SELF);
  });

  it("increments seq across advertise cycles", async () => {
    const kp = await parseKeyPairFromPem(PEM);
    const send = vi.fn(async () => {});
    const client = {
      topology: vi.fn(async () => fakeTopology(["a".repeat(64)])),
      send,
    };
    const adv = new Advertiser({
      client,
      keyPair: kp,
      intervalMs: 10_000,
      ttlMs: 30_000,
      getTopics: () => ["t"],
    });
    adv.start();
    await settle(10);
    await adv.refresh();
    await adv.refresh();
    await adv.stop();
    const seqs: number[] = [];
    for (const call of send.mock.calls) {
      const decoded = await decode(call[1] as Uint8Array);
      if (decoded.kind === "sub_ad") seqs.push(decoded.seq);
    }
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("reports topology errors via onError and does not send", async () => {
    const kp = await parseKeyPairFromPem(PEM);
    const send = vi.fn(async () => {});
    const errors: Error[] = [];
    const client = {
      topology: vi.fn(async () => {
        throw new Error("topology boom");
      }),
      send,
    };
    const adv = new Advertiser({
      client,
      keyPair: kp,
      intervalMs: 10_000,
      ttlMs: 30_000,
      getTopics: () => ["t"],
      onError: (e) => errors.push(e),
    });
    adv.start();
    await settle(20);
    await adv.stop();
    expect(send).not.toHaveBeenCalled();
    expect(errors[0]?.message).toBe("topology boom");
  });

  it("reports per-peer send failures but still sends to other peers", async () => {
    const kp = await parseKeyPairFromPem(PEM);
    const errors: Error[] = [];
    const peerA = "a".repeat(64);
    const peerB = "b".repeat(64);
    const send = vi.fn(async (dest: string) => {
      if (dest === peerA) throw new Error("dial error");
    });
    const client = {
      topology: vi.fn(async () => fakeTopology([peerA, peerB])),
      send,
    };
    const adv = new Advertiser({
      client,
      keyPair: kp,
      intervalMs: 10_000,
      ttlMs: 30_000,
      getTopics: () => ["t"],
      onError: (e) => errors.push(e),
    });
    adv.start();
    await settle(20);
    await adv.stop();
    expect(send).toHaveBeenCalledTimes(2);
    expect(errors[0]?.message).toBe("dial error");
  });
});
