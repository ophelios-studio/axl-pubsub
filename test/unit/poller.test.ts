import { describe, expect, it, vi } from "vitest";
import { encodePub } from "../../src/envelope.js";
import { Poller } from "../../src/poller.js";
import { parseKeyPairFromPem } from "../../src/signing.js";

const PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIMpAWJ/6tD/Xu+KZO6+ouV+keSKlVxVljlMSUF+Wr2id
-----END PRIVATE KEY-----
`;

async function settle(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scriptedClient(queue: (() => Promise<unknown>)[]) {
  let idx = 0;
  return {
    recv: async () => {
      const step = queue[idx++] ?? (async () => null);
      return step();
    },
  };
}

describe("Poller", () => {
  it("decodes a pub and delivers it to onMessage", async () => {
    const kp = await parseKeyPairFromPem(PEM);
    const bytes = await encodePub({ topic: "news.test", payload: new Uint8Array([1]), keyPair: kp });
    const client = scriptedClient([
      async () => ({ fromHeader: "ee", body: bytes }),
      async () => null,
    ]);
    const received: unknown[] = [];
    const errors: Error[] = [];
    const p = new Poller({
      client,
      intervalMs: 2,
      onMessage: (d) => {
        received.push(d);
      },
      onError: (e) => errors.push(e),
    });
    p.start();
    await settle(30);
    await p.stop();
    expect(errors).toEqual([]);
    expect(received).toHaveLength(1);
  });

  it("reports EnvelopeError via onError for tampered bodies", async () => {
    const body = new TextEncoder().encode('{"axp":1,"kind":"pub","a2a":true}');
    const client = scriptedClient([async () => ({ fromHeader: "x", body })]);
    const errors: Error[] = [];
    const p = new Poller({
      client,
      intervalMs: 2,
      onMessage: () => {},
      onError: (e) => errors.push(e),
    });
    p.start();
    await settle(20);
    await p.stop();
    expect(errors[0]?.name).toBe("EnvelopeError");
  });

  it("surfaces errors from client.recv and keeps running", async () => {
    const client = scriptedClient([
      async () => {
        throw new Error("network blip");
      },
      async () => null,
    ]);
    const errors: Error[] = [];
    const p = new Poller({
      client,
      intervalMs: 2,
      onMessage: () => {},
      onError: (e) => errors.push(e),
    });
    p.start();
    await settle(30);
    await p.stop();
    expect(errors[0]?.message).toBe("network blip");
  });

  it("catches handler exceptions and keeps pumping", async () => {
    const kp = await parseKeyPairFromPem(PEM);
    const bytes = await encodePub({ topic: "t", payload: new Uint8Array(), keyPair: kp });
    const client = scriptedClient([
      async () => ({ fromHeader: "x", body: bytes }),
      async () => null,
    ]);
    const errors: Error[] = [];
    const handler = vi.fn(() => {
      throw new Error("handler crashed");
    });
    const p = new Poller({
      client,
      intervalMs: 2,
      onMessage: handler,
      onError: (e) => errors.push(e),
    });
    p.start();
    await settle(30);
    await p.stop();
    expect(handler).toHaveBeenCalled();
    expect(errors[0]?.message).toBe("handler crashed");
  });
});
