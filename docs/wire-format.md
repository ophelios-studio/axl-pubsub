# Wire Format

Spec of record for envelopes sent via `POST /send` on AXL. Receivers use this spec to decode and authenticate incoming messages on `GET /recv`. Version 1.

## Goals

- **Avoid AXL's routing hijacks.** Top-level JSON containing `service` is diverted to AXL's MCP router; top-level `a2a: true` is diverted to the A2A server. Messages with those keys never reach `/recv`. Our envelope uses neither.
- **Carry the full sender identity.** `GET /recv`'s `X-From-Peer-Id` header is a truncated Yggdrasil-IPv6-derived prefix of the sender's ed25519 public key (trailing `0xff` padding, one mixed-bit byte). It cannot be used to reply with `/send`. The envelope therefore carries the sender's full 64-hex pubkey and an ed25519 signature binding the payload to that pubkey.
- **Deduplicate.** Each `pub` carries a ULID so receivers can drop exact replays within a dedup window.
- **Stay small enough for 1–10 KB payloads in bulk.** JSON with base64 payload adds ~33% overhead; trivial at the target payload sizes, well inside AXL's 16 MB per-message ceiling.

## Envelope top-level

Every envelope is a JSON object with:

| field | type    | required | description                                  |
|-------|---------|----------|----------------------------------------------|
| `axp` | integer | yes      | Protocol version. Must equal `1`.            |
| `kind`| string  | yes      | `"pub"`, `"sub_ad"`, or `"unsub_ad"`.        |

Receivers MUST reject envelopes missing `axp`, with `axp !== 1`, or with an unknown `kind`.

## `pub` (published message)

```json
{
  "axp": 1,
  "kind": "pub",
  "id": "01HZ7XYAXGZ4N7V3WQ1F7R8PK2",
  "topic": "immunity.antibody.address",
  "from": "eeb76d51d746d3aa7a20fcfbf2b507bb37c461ca8e9c2519058fc6f993204764",
  "ts": 1714000000000,
  "payload": "SGVsbG8sIHdvcmxkIQ==",
  "sig": "Ht/p...base64..."
}
```

| field     | type    | notes                                                                 |
|-----------|---------|-----------------------------------------------------------------------|
| `id`      | string  | 26-character [ULID](https://github.com/ulid/spec). Unique per publisher. |
| `topic`   | string  | Dot-separated segments; see *Topic syntax*. Publishers emit concrete topics only (no wildcards in `pub`). |
| `from`    | string  | 64-hex (lowercase) ed25519 public key of the publisher.              |
| `ts`      | integer | Unix milliseconds when the publisher emitted the message.            |
| `payload` | string  | Base64 (standard, padded) of the raw payload bytes.                  |
| `sig`     | string  | Base64 of the 64-byte ed25519 signature over canonical bytes (below).|

### Canonical signing bytes for `pub`

The signature covers a deterministic byte string, assembled without JSON serialization:

```
concat(
  utf8("axp:1|pub|"),
  utf8(id),
  utf8("|"),
  utf8(topic),
  utf8("|"),
  utf8(from),
  utf8("|"),
  utf8(decimal(ts)),
  utf8("|"),
  rawPayloadBytes          // the pre-base64 bytes
)
```

`decimal(ts)` is the base-10 integer with no leading zeros. `rawPayloadBytes` is the binary payload as provided to `publish()`, not the base64 text. The layout is fixed; there is no JSON-canonicalization step.

## `sub_ad` (subscription announcement)

```json
{
  "axp": 1,
  "kind": "sub_ad",
  "from": "eeb76d51...04764",
  "topics": ["immunity.antibody.*", "news.test"],
  "seq": 42,
  "ts": 1714000000000,
  "ttl_ms": 90000,
  "sig": "base64..."
}
```

| field     | type     | notes                                                                 |
|-----------|----------|-----------------------------------------------------------------------|
| `from`    | string   | 64-hex ed25519 public key of the subscriber.                         |
| `topics`  | string[] | Topic patterns this node subscribes to; see *Topic syntax*.          |
| `seq`     | integer  | Monotonic counter per sender. Receivers ignore any `sub_ad` whose `seq ≤ lastSeenSeq` for that `from`. |
| `ts`      | integer  | Unix ms when emitted.                                                |
| `ttl_ms`  | integer  | How long the receiver should retain this entry without a refresh.    |
| `sig`     | string   | Ed25519 signature over canonical bytes (below).                      |

### Canonical signing bytes for `sub_ad`

```
concat(
  utf8("axp:1|sub_ad|"),
  utf8(from),
  utf8("|"),
  utf8(topics.join(",")),   // preserves order given by publisher
  utf8("|"),
  utf8(decimal(seq)),
  utf8("|"),
  utf8(decimal(ts)),
  utf8("|"),
  utf8(decimal(ttl_ms))
)
```

Topic strings must not contain `,` or `|`; the topic-syntax rules below make that impossible.

## `unsub_ad` (unsubscription announcement, v0.1 stretch)

Same shape and canonical layout as `sub_ad` with `kind: "unsub_ad"` and `topics` listing the patterns being dropped. Receivers apply by removing those patterns from the sender's entry; if the remaining set is empty, the entry is evicted. If a node opts not to send `unsub_ad`, peers simply wait for TTL expiry.

## Topic syntax

- Segments separated by `.`, e.g. `immunity.antibody.address`.
- Each segment is a non-empty ASCII string matching `[A-Za-z0-9_-]+`.
- `*` is a single-segment wildcard. `immunity.antibody.*` matches `immunity.antibody.address` but not `immunity.antibody.a.b` and not `immunity.antibody`.
- Concrete topics (used in `pub`) MUST NOT contain `*`.
- Multi-segment wildcards (`#`) are reserved for v0.2 and currently invalid.

Matching is case-sensitive.

## Receiver validation

On every `/recv`, receivers MUST, in order:

1. Parse the body as JSON. If parsing fails, drop and emit an `error` event.
2. Check `axp === 1` and `kind ∈ {"pub", "sub_ad", "unsub_ad"}`. Otherwise drop.
3. Shape-validate the kind-specific fields (types, ranges, base64 decodability for `pub.payload`).
4. Verify `sig` against the canonical bytes using the `from` pubkey. If verification fails, drop and emit `error`.
5. **Spoof screen.** Check that the `X-From-Peer-Id` HTTP header is a prefix-match of `from` per the algorithm documented in the AXL spike's FINDINGS.md (strip trailing `0xff`, drop last mixed-bit byte, prefix-compare). On mismatch, drop and emit `error`. This is a cheap pre-check before the full signature verification and guards against a compromised peer spoofing `from` without matching the underlying Yggdrasil address.
6. For `pub`: dedup by `(from, id)` within the configured window; if fresh, topic-match against local subscriptions and deliver.
7. For `sub_ad` / `unsub_ad`: verify `seq > lastSeq[from]`; on success, update the local peer→topics table and emit `peer-joined` / `peer-topics-changed` as appropriate.

Errors are surfaced via the `error` event, never thrown. Lossy semantics are AXL's contract, not ours to override.

## Forbidden top-level keys

`axl-pubsub` envelopes MUST NOT include `service` (would divert to MCP) or `a2a` (would divert to A2A). Implementations SHOULD reject outbound payloads that happen to include those keys as a safety check.

## Versioning

`axp` is an integer protocol version. Any breaking change to envelope shape, canonical-byte layout, or validation rules increments the number. v0.1 ships `axp: 1`. Receivers MUST drop envelopes with a higher `axp` than they understand rather than best-effort parse them.
