// Minimal publisher: every 2 seconds, publish a message to "news.test".
// Run with:
//   AXL_URL=http://localhost:9002 PRIVATE_KEY_PATH=./alice.pem \
//     npx tsx examples/simple-pub.ts

import { Gossip } from "axl-pubsub";

const axlUrl = process.env.AXL_URL ?? "http://localhost:9002";
const privateKeyPath = process.env.PRIVATE_KEY_PATH;
if (!privateKeyPath) {
  console.error("PRIVATE_KEY_PATH env var is required");
  process.exit(1);
}

const ps = new Gossip({ axlUrl, privateKeyPath });
await ps.start();
console.log(`publisher started; axlUrl=${axlUrl}`);

let seq = 0;
const timer = setInterval(async () => {
  const payload = new TextEncoder().encode(JSON.stringify({ seq: seq++, ts: Date.now() }));
  const result = await ps.publish("news.test", payload);
  console.log(
    `publish seq=${seq - 1} sentTo=${result.sentTo.length} failed=${result.failed.length}`,
  );
}, 2000);

const stop = async () => {
  clearInterval(timer);
  await ps.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
