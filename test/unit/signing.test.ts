import { describe, expect, it } from "vitest";
import {
  SigningError,
  bytesToHex,
  parseKeyPairFromPem,
  sign,
  verify,
} from "../../src/signing.js";

// Throwaway ed25519 keypair generated specifically for these tests.
// Never funded, never used outside this repo. Safe to expose publicly.
const FIXTURE_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIMpAWJ/6tD/Xu+KZO6+ouV+keSKlVxVljlMSUF+Wr2id
-----END PRIVATE KEY-----
`;

const FIXTURE_PUBKEY_HEX = "707c630a6f28cd368ab6fd4a9f66015bfccc742a004944337b198a94322e773c";

describe("parseKeyPairFromPem", () => {
  it("extracts the expected public key from a PKCS#8 ed25519 PEM", async () => {
    const kp = await parseKeyPairFromPem(FIXTURE_PEM);
    expect(kp.publicKeyHex).toBe(FIXTURE_PUBKEY_HEX);
    expect(kp.privateKey).toHaveLength(32);
    expect(kp.publicKey).toHaveLength(32);
  });

  it("rejects a PEM without a PRIVATE KEY block", async () => {
    await expect(parseKeyPairFromPem("nope")).rejects.toBeInstanceOf(SigningError);
  });

  it("rejects a PEM whose DER is not 48 bytes", async () => {
    const bad = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";
    await expect(parseKeyPairFromPem(bad)).rejects.toBeInstanceOf(SigningError);
  });
});

describe("sign / verify", () => {
  it("round-trips a signature over a message", async () => {
    const kp = await parseKeyPairFromPem(FIXTURE_PEM);
    const msg = new TextEncoder().encode("axp:1|pub|example");
    const sig = await sign(msg, kp.privateKey);
    expect(sig).toHaveLength(64);
    expect(await verify(sig, msg, kp.publicKey)).toBe(true);
  });

  it("fails verification when the message is tampered", async () => {
    const kp = await parseKeyPairFromPem(FIXTURE_PEM);
    const msg = new TextEncoder().encode("hello");
    const sig = await sign(msg, kp.privateKey);
    const tampered = new TextEncoder().encode("hellp");
    expect(await verify(sig, tampered, kp.publicKey)).toBe(false);
  });

  it("fails verification under a different public key", async () => {
    const kp = await parseKeyPairFromPem(FIXTURE_PEM);
    const msg = new TextEncoder().encode("hello");
    const sig = await sign(msg, kp.privateKey);
    const otherPub = new Uint8Array(32);
    otherPub[0] = 1;
    expect(await verify(sig, msg, otherPub)).toBe(false);
  });

  it("exposes bytesToHex as a deterministic lowercase hex encoder", () => {
    expect(bytesToHex(new Uint8Array([0x0a, 0xff, 0x01]))).toBe("0aff01");
  });
});
