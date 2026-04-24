import { ulid } from "ulid";
import { type KeyPair, hexToBytes, sign, verify } from "./signing.js";

export const PROTOCOL_VERSION = 1;

export type DecodedPub = {
  kind: "pub";
  id: string;
  topic: string;
  from: string;
  ts: number;
  payload: Uint8Array;
};

export type DecodedSubAd = {
  kind: "sub_ad";
  from: string;
  topics: string[];
  seq: number;
  ts: number;
  ttl_ms: number;
};

export type Decoded = DecodedPub | DecodedSubAd;

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

const TE = new TextEncoder();

export async function encodePub(args: {
  topic: string;
  payload: Uint8Array;
  keyPair: KeyPair;
  id?: string;
  now?: () => number;
}): Promise<Uint8Array> {
  const id = args.id ?? ulid();
  const ts = (args.now ?? Date.now)();
  const from = args.keyPair.publicKeyHex;
  const canonical = canonicalPubBytes({ id, topic: args.topic, from, ts, payload: args.payload });
  const sig = await sign(canonical, args.keyPair.privateKey);
  return TE.encode(
    JSON.stringify({
      axp: 1,
      kind: "pub",
      id,
      topic: args.topic,
      from,
      ts,
      payload: bytesToBase64(args.payload),
      sig: bytesToBase64(sig),
    }),
  );
}

export async function encodeSubAd(args: {
  topics: string[];
  seq: number;
  ttlMs: number;
  keyPair: KeyPair;
  now?: () => number;
}): Promise<Uint8Array> {
  const ts = (args.now ?? Date.now)();
  const from = args.keyPair.publicKeyHex;
  const canonical = canonicalSubAdBytes({
    from,
    topics: args.topics,
    seq: args.seq,
    ts,
    ttlMs: args.ttlMs,
  });
  const sig = await sign(canonical, args.keyPair.privateKey);
  return TE.encode(
    JSON.stringify({
      axp: 1,
      kind: "sub_ad",
      from,
      topics: args.topics,
      seq: args.seq,
      ts,
      ttl_ms: args.ttlMs,
      sig: bytesToBase64(sig),
    }),
  );
}

export async function decode(body: Uint8Array): Promise<Decoded> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new EnvelopeError("body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EnvelopeError("envelope must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if ("service" in obj || "a2a" in obj) {
    throw new EnvelopeError("envelope uses an AXL-reserved top-level key");
  }
  if (obj.axp !== PROTOCOL_VERSION) {
    throw new EnvelopeError(`unsupported axp version: ${String(obj.axp)}`);
  }
  if (obj.kind === "pub") return decodePub(obj);
  if (obj.kind === "sub_ad") return decodeSubAd(obj);
  throw new EnvelopeError(`unknown kind: ${String(obj.kind)}`);
}

async function decodePub(obj: Record<string, unknown>): Promise<DecodedPub> {
  const id = reqStr(obj, "id");
  const topic = reqStr(obj, "topic");
  const from = reqStr(obj, "from");
  const ts = reqNum(obj, "ts");
  const payload = base64ToBytes(reqStr(obj, "payload"));
  const sig = base64ToBytes(reqStr(obj, "sig"));
  const canonical = canonicalPubBytes({ id, topic, from, ts, payload });
  if (!(await verify(sig, canonical, hexToBytes(from)))) {
    throw new EnvelopeError("pub signature verification failed");
  }
  return { kind: "pub", id, topic, from, ts, payload };
}

async function decodeSubAd(obj: Record<string, unknown>): Promise<DecodedSubAd> {
  const from = reqStr(obj, "from");
  const topicsRaw = obj.topics;
  if (!Array.isArray(topicsRaw) || !topicsRaw.every((t) => typeof t === "string")) {
    throw new EnvelopeError("sub_ad.topics must be an array of strings");
  }
  const topics = topicsRaw as string[];
  const seq = reqNum(obj, "seq");
  const ts = reqNum(obj, "ts");
  const ttl_ms = reqNum(obj, "ttl_ms");
  const sig = base64ToBytes(reqStr(obj, "sig"));
  const canonical = canonicalSubAdBytes({ from, topics, seq, ts, ttlMs: ttl_ms });
  if (!(await verify(sig, canonical, hexToBytes(from)))) {
    throw new EnvelopeError("sub_ad signature verification failed");
  }
  return { kind: "sub_ad", from, topics, seq, ts, ttl_ms };
}

function canonicalPubBytes(args: {
  id: string;
  topic: string;
  from: string;
  ts: number;
  payload: Uint8Array;
}): Uint8Array {
  const header = TE.encode(`axp:1|pub|${args.id}|${args.topic}|${args.from}|${args.ts}|`);
  const out = new Uint8Array(header.length + args.payload.length);
  out.set(header, 0);
  out.set(args.payload, header.length);
  return out;
}

function canonicalSubAdBytes(args: {
  from: string;
  topics: string[];
  seq: number;
  ts: number;
  ttlMs: number;
}): Uint8Array {
  return TE.encode(
    `axp:1|sub_ad|${args.from}|${args.topics.join(",")}|${args.seq}|${args.ts}|${args.ttlMs}`,
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

function reqStr(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string") throw new EnvelopeError(`missing or non-string field: ${key}`);
  return v;
}

function reqNum(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new EnvelopeError(`missing or non-finite number field: ${key}`);
  }
  return v;
}
