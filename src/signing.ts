import { readFileSync } from "node:fs";
import * as ed25519 from "@noble/ed25519";

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
}

export class SigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningError";
  }
}

const PEM_BLOCK = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/;
const ED25519_PKCS8_DER_LENGTH = 48;
const ED25519_SEED_OFFSET = 16;

export async function loadKeyPairFromPem(path: string): Promise<KeyPair> {
  return parseKeyPairFromPem(readFileSync(path, "utf8"));
}

export async function parseKeyPairFromPem(pemText: string): Promise<KeyPair> {
  const match = PEM_BLOCK.exec(pemText);
  if (!match) {
    throw new SigningError("PEM does not contain a PKCS#8 PRIVATE KEY block");
  }
  const base64Body = (match[1] ?? "").replace(/\s+/g, "");
  const der = Uint8Array.from(Buffer.from(base64Body, "base64"));
  if (der.length !== ED25519_PKCS8_DER_LENGTH) {
    throw new SigningError(
      `unexpected DER length ${der.length}; expected ${ED25519_PKCS8_DER_LENGTH} for ed25519 PKCS#8`,
    );
  }
  const seed = der.subarray(ED25519_SEED_OFFSET);
  const publicKey = await ed25519.getPublicKeyAsync(seed);
  return {
    privateKey: seed,
    publicKey,
    publicKeyHex: ed25519.etc.bytesToHex(publicKey),
  };
}

export async function sign(message: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array> {
  return ed25519.signAsync(message, privateKey);
}

export async function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  try {
    return await ed25519.verifyAsync(signature, message, publicKey);
  } catch {
    return false;
  }
}

export const bytesToHex = ed25519.etc.bytesToHex;
export const hexToBytes = ed25519.etc.hexToBytes;
