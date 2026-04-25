# axl-pubsub

Topic-based pub/sub gossip on top of [Gensyn AXL](https://github.com/gensyn-ai/axl).

AXL ships with `POST /send` (unicast) and `GET /recv` (polled FIFO queue). It does not natively support topics, subscription registries, or broadcast. `axl-pubsub` is a TypeScript library that runs in-process alongside an AXL node and adds:

- **Topic-based pub/sub** with dot-separated names and `*` single-segment wildcards (e.g. `news.*`).
- **Decentralized subscription discovery** via signed periodic announcements over `/send`. No central registry.
- **Authenticated origin.** Every published message and announcement carries an ed25519 signature; receivers verify before delivery.
- **Fan-out at the publisher.** Publishers consult their local peer-to-topics table and send only to matching subscribers.
- **Dedup.** Duplicate `(from, id)` deliveries are dropped within a configurable time window.

Pinned against AXL [`9cba555`](https://github.com/gensyn-ai/axl/commit/9cba555ff0b8e14ebf1244ae02b274fbc4ec044e).

## Install

```bash
npm install axl-pubsub
```

Requires Node 18+.

## Quick start

You need an AXL node running locally with its HTTP API exposed (default `:9002`) and an ed25519 PEM key (`openssl genpkey -algorithm ed25519`).

```ts
import { Gossip } from "axl-pubsub";

const ps = new Gossip({
  axlUrl: "http://localhost:9002",
  privateKeyPath: "/keys/me.pem",
});

await ps.start();

// Subscribe with a wildcard
await ps.subscribe("news.*", (msg) => {
  console.log(msg.topic, "from", msg.from, ":", new TextDecoder().decode(msg.payload));
});

// Publish to a concrete topic
await ps.publish("news.test", new TextEncoder().encode("hello"));

await ps.stop();
```

## Public API

```ts
const ps = new Gossip({
  axlUrl,                          // required: AXL node base URL
  privateKeyPath,                  // OR keyPair: KeyPair
  pollIntervalMs: 25,              // /recv poll cadence
  advertiseIntervalMs: 30_000,     // sub_ad cadence
  subscriptionTtlMs: 90_000,       // peer entry TTL
  dedupWindowMs: 60_000,           // (from, id) dedup window
  peerSweepIntervalMs: 5_000,      // peer-left sweep cadence
  maxPayloadBytes: 16_775_168,     // headroom under AXL's 16 MB
});

await ps.start();
const sub = await ps.subscribe(pattern, handler);
const result = await ps.publish(topic, payloadBytes);
//   { id, sentTo: pubkey[], failed: { pubkey, error }[] }
ps.knownPeers();                   // peers and their topic patterns
ps.subscribersFor(topic);          // pubkeys whose patterns match
ps.on("peer-joined" | "peer-left" | "error", handler);
await sub.unsubscribe();
await ps.stop();
```

## How discovery works

Each node periodically signs and broadcasts a `sub_ad` envelope listing its current subscription patterns. Every receiving node verifies the signature, validates monotonic `seq`, and updates its local peer-to-topics table with the supplied `ttl_ms`. When the publisher emits, it consults that local table and fan-outs only to matching peers.

This is a one-hop announcement model in v0.1. Scaling considerations: O(N²) announcements per cycle. Fine to ~100 nodes at a 30s cycle. Beyond that, see *Known limitations*.

## Wire format

Detailed envelope spec, canonical signing layout, and validation rules: [`docs/wire-format.md`](docs/wire-format.md).

## Known limitations

[`docs/known-limitations.md`](docs/known-limitations.md) documents what v0.1 explicitly does not handle (no store-and-forward, no message ordering guarantees, no multi-hop relay, no `#` wildcard, etc.).

## Testing

Unit tests run without any infrastructure:

```bash
npm test
```

Integration tests require Docker. The 3-node AXL mesh and lifecycle are wrapped in npm scripts:

```bash
npm run integration:up        # generate keys, build AXL image, start the mesh
npm run test:integration      # run the suite against the running mesh
npm run integration:down      # tear down when done
```

`integration:up` is idempotent: keys persist between runs (gitignored), and the AXL image only rebuilds when its source changes. `npm run integration:logs` tails container logs.

On macOS, default `openssl` is LibreSSL and rejects ed25519. Override the binary used for key generation:

```bash
make -C test/integration/compose keys OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl
```

Run that once, then the regular npm scripts work.

## License

Apache-2.0.
