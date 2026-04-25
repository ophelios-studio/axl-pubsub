# Known Limitations (v0.1)

What `axl-pubsub` deliberately does not handle in v0.1, why, and what to do instead. Read this before adopting the library for anything beyond best-effort delivery.

## No store-and-forward

AXL itself has no persistence layer for `/send`. If a destination peer is offline at publish time, that delivery fails permanently. `axl-pubsub` does not retry, does not queue, and does not warn other subscribers that one missed the message. Per-peer failures are surfaced in `PublishResult.failed` so callers can log or react, but the library will not try again.

If you need durable delivery, place a journal in front of `publish()` (your own application code) or treat pub/sub as a notification fast-path on top of an authoritative store, the way the first known consumer (Immunity) treats its on-chain registry.

## Late subscribers do not see history

A subscriber that registers a pattern at time T sees only messages published at or after T (modulo propagation latency for the `sub_ad` to reach publishers). There is no replay endpoint. New nodes joining a long-running mesh start with empty state. If your application needs replay, mirror the message stream into your own log and serve from there.

## No message ordering guarantees

`axl-pubsub` does not impose ordering. A handler may receive messages from the same publisher out of order, and certainly from different publishers in interleaved order. AXL's `/send` is per-call; the underlying Yggdrasil routes can change between calls. If your protocol needs ordering, embed sequence numbers in your payload and resolve at the application layer.

## No multi-level wildcard

`*` matches exactly one segment. `immunity.antibody.*` matches `immunity.antibody.address` but not `immunity.antibody.address.v2`. There is no `#` (multi-segment) wildcard in v0.1. Workaround: subscribe to multiple specific patterns, or restructure topics so the depth you care about is constant.

## Subscription discovery is one-hop, O(N²) per cycle

Each node fan-outs its `sub_ad` to every reachable peer from `/topology` once per `advertiseIntervalMs`. There is no relay. At N=60 nodes with a 30 s cycle that is 60 announcements per node, 120 messages/sec network-wide; comfortable. At N=500 it becomes burdensome (~8000 msg/s during ad bursts). Future versions may introduce bloom-digest gossip with selective relay; for now, plan for ≤ ~150 nodes per mesh or shard topics across multiple meshes.

## No back-pressure to publishers

If a subscriber cannot keep up with its `/recv` queue, AXL queues messages in memory on the subscriber's node. There is no signal back to publishers asking them to slow down, and no built-in rate limit. A flooded subscriber will eventually exhaust memory at the AXL node level. Mitigations: keep handlers fast and non-blocking, raise `pollIntervalMs` aggressiveness, or run a buffered async queue between `subscribe()` and your slow processor.

## No encryption beyond Yggdrasil transport

AXL nodes peer over TLS via Yggdrasil, so traffic between nodes is encrypted on the wire. `axl-pubsub` adds no additional payload encryption. Anyone running a node in the same Yggdrasil network can decode `pub` envelopes addressed to them and inspect topics + payloads. If you need confidentiality from other subscribers, encrypt your payload bytes before calling `publish()`.

## No anti-spam, rate-limit, or reputation

A misbehaving peer can flood the mesh with `sub_ad` and `pub` messages. Signature verification only proves origin, not honesty. v0.1 has no built-in throttling or peer scoring. Tooling for this is on the roadmap; for now, applications that worry about adversarial peers should layer their own peer allow-list at the `subscribe()` filter level.

## Identity is ephemeral without a persistent PEM

If the AXL node is started without `PrivateKeyPath`, AXL generates a fresh ed25519 key on every restart. Your node's pubkey changes, your sub_ads from the previous run become orphaned in peers' tables until they expire, and any signatures you produced are no longer recognized as yours. Always supply a persistent PEM path.

## Stop() does not abort an in-flight `/recv`

`Poller.stop()` ends the polling loop after the current iteration completes. If the loop is mid-`fetch('/recv')` when stop is called, the call runs to completion before the loop exits. AXL's `/recv` returns 204 quickly when empty, so worst case is bounded by one HTTP round-trip. If your environment ever has a `/recv` that hangs, plumb an `AbortController` into `AxlClient` (not done in v0.1).

## Max message size is AXL's 16 MB

`axl-pubsub` defaults to a slightly conservative `maxPayloadBytes: 16 MB - 1 KB` to leave headroom for the JSON envelope overhead. Larger payloads must be chunked at the application layer; this library does not split or reassemble.

## Topic syntax is intentionally narrow

Each segment must match `[A-Za-z0-9_-]+`. No dots inside segments, no spaces, no Unicode. The narrowness is what makes the canonical signing-byte layout for `sub_ad` unambiguous (see `docs/wire-format.md`). Loosening topic syntax later requires either escaping or a different separator and is a breaking change to `axp`.
