// Minimal subscriber: subscribe to "news.*" and log each verified message.
// Run with:
//   AXL_URL=http://localhost:9012 PRIVATE_KEY_PATH=./bob.pem \
//     npx tsx examples/simple-sub.ts

import { Gossip } from "axl-pubsub";

const axlUrl = process.env.AXL_URL ?? "http://localhost:9002";
const privateKeyPath = process.env.PRIVATE_KEY_PATH;
if (!privateKeyPath) {
  console.error("PRIVATE_KEY_PATH env var is required");
  process.exit(1);
}

const ps = new Gossip({ axlUrl, privateKeyPath });

ps.on("peer-joined", (p: { pubkey: string; topics: string[] }) => {
  console.log(`peer-joined: ${p.pubkey.slice(0, 12)}… topics=${p.topics.join(",")}`);
});
ps.on("peer-left", (p: { pubkey: string }) => {
  console.log(`peer-left: ${p.pubkey.slice(0, 12)}…`);
});
ps.on("error", (err: Error) => {
  console.error("error:", err.message);
});

await ps.start();
await ps.subscribe("news.*", (msg) => {
  const text = new TextDecoder().decode(msg.payload);
  console.log(`[${msg.topic}] from=${msg.from.slice(0, 12)}… ${text}`);
});

console.log(`subscriber started; axlUrl=${axlUrl}; pattern=news.*`);

const stop = async () => {
  await ps.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
