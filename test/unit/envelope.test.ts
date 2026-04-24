import { describe, expect, it } from "vitest";
import { EnvelopeError, decode, encodePub, encodeSubAd } from "../../src/envelope.js";
import { parseKeyPairFromPem } from "../../src/signing.js";

// Throwaway ed25519 keypair generated specifically for these tests.
// Never funded, never used outside this repo. Safe to expose publicly.
const PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIMpAWJ/6tD/Xu+KZO6+ouV+keSKlVxVljlMSUF+Wr2id
-----END PRIVATE KEY-----
`;
const PUB_HEX = "707c630a6f28cd368ab6fd4a9f66015bfccc742a004944337b198a94322e773c";

async function kp() {
  return parseKeyPairFromPem(PEM);
}

describe("encodePub / decode", () => {
  it("round-trips a pub envelope with verified sender", async () => {
    const keyPair = await kp();
    const payload = new TextEncoder().encode("hello");
    const bytes = await encodePub({
      topic: "news.test",
      payload,
      keyPair,
      id: "01HZ7XYAXGZ4N7V3WQ1F7R8PK2",
      now: () => 1714000000000,
    });
    const decoded = await decode(bytes);
    expect(decoded.kind).toBe("pub");
    if (decoded.kind !== "pub") return;
    expect(decoded.topic).toBe("news.test");
    expect(decoded.from).toBe(PUB_HEX);
    expect(decoded.id).toBe("01HZ7XYAXGZ4N7V3WQ1F7R8PK2");
    expect(decoded.ts).toBe(1714000000000);
    expect(new TextDecoder().decode(decoded.payload)).toBe("hello");
  });

  it("rejects a pub whose payload has been tampered with", async () => {
    const keyPair = await kp();
    const bytes = await encodePub({
      topic: "t",
      payload: new Uint8Array([1, 2, 3]),
      keyPair,
    });
    const json = JSON.parse(Buffer.from(bytes).toString("utf8"));
    json.payload = Buffer.from(new Uint8Array([9, 9, 9])).toString("base64");
    const tampered = new TextEncoder().encode(JSON.stringify(json));
    await expect(decode(tampered)).rejects.toBeInstanceOf(EnvelopeError);
  });
});

describe("encodeSubAd / decode", () => {
  it("round-trips a sub_ad with topics, seq, ttl", async () => {
    const keyPair = await kp();
    const bytes = await encodeSubAd({
      topics: ["immunity.antibody.*", "news.test"],
      seq: 42,
      ttlMs: 90_000,
      keyPair,
      now: () => 1714000000000,
    });
    const decoded = await decode(bytes);
    expect(decoded.kind).toBe("sub_ad");
    if (decoded.kind !== "sub_ad") return;
    expect(decoded.from).toBe(PUB_HEX);
    expect(decoded.topics).toEqual(["immunity.antibody.*", "news.test"]);
    expect(decoded.seq).toBe(42);
    expect(decoded.ts).toBe(1714000000000);
    expect(decoded.ttl_ms).toBe(90_000);
  });

  it("rejects a sub_ad whose seq has been tampered with", async () => {
    const keyPair = await kp();
    const bytes = await encodeSubAd({
      topics: ["news.test"],
      seq: 1,
      ttlMs: 30_000,
      keyPair,
    });
    const json = JSON.parse(Buffer.from(bytes).toString("utf8"));
    json.seq = 99;
    const tampered = new TextEncoder().encode(JSON.stringify(json));
    await expect(decode(tampered)).rejects.toBeInstanceOf(EnvelopeError);
  });
});

describe("decode validation", () => {
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

  it("rejects envelopes with the MCP-hijack `service` key", async () => {
    await expect(decode(enc({ axp: 1, kind: "pub", service: "x" }))).rejects.toBeInstanceOf(
      EnvelopeError,
    );
  });

  it("rejects envelopes with the A2A-hijack `a2a` key", async () => {
    await expect(decode(enc({ axp: 1, kind: "pub", a2a: true }))).rejects.toBeInstanceOf(
      EnvelopeError,
    );
  });

  it("rejects unknown axp version", async () => {
    await expect(decode(enc({ axp: 2, kind: "pub" }))).rejects.toBeInstanceOf(EnvelopeError);
  });

  it("rejects unknown kind", async () => {
    await expect(decode(enc({ axp: 1, kind: "mystery" }))).rejects.toBeInstanceOf(EnvelopeError);
  });

  it("rejects non-object top-level", async () => {
    await expect(decode(enc([]))).rejects.toBeInstanceOf(EnvelopeError);
    await expect(decode(new TextEncoder().encode("not json"))).rejects.toBeInstanceOf(
      EnvelopeError,
    );
  });
});
