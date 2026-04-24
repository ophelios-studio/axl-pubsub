import { describe, expect, it, vi } from "vitest";
import { AxlClient, AxlClientError } from "../../src/axl-client.js";

function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn((input: URL | RequestInfo, init?: RequestInit) =>
    Promise.resolve(impl(String(input), init)),
  ) as unknown as typeof fetch;
}

describe("AxlClient.topology", () => {
  it("parses the /topology JSON payload", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toBe("http://localhost:9002/topology");
      return new Response(
        JSON.stringify({
          our_ipv6: "200::1",
          our_public_key: "a".repeat(64),
          peers: [{ public_key: "b".repeat(64) }],
          tree: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const client = new AxlClient({ baseUrl: "http://localhost:9002", fetchImpl });
    const t = await client.topology();
    expect(t.our_public_key).toBe("a".repeat(64));
    expect(t.peers[0]?.public_key).toBe("b".repeat(64));
  });

  it("throws AxlClientError on non-200", async () => {
    const fetchImpl = mockFetch(() => new Response("nope", { status: 500 }));
    const client = new AxlClient({ baseUrl: "http://x", fetchImpl });
    await expect(client.topology()).rejects.toBeInstanceOf(AxlClientError);
  });
});

describe("AxlClient.send", () => {
  it("posts body with X-Destination-Peer-Id header", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const fetchImpl = mockFetch((url, init) => {
      captured.url = url;
      captured.init = init;
      return new Response(null, { status: 200, headers: { "X-Sent-Bytes": "5" } });
    });
    const client = new AxlClient({ baseUrl: "http://x/", fetchImpl });
    await client.send("ee".repeat(32), new Uint8Array([1, 2, 3, 4, 5]));
    expect(captured.url).toBe("http://x/send");
    expect((captured.init?.headers as Record<string, string>)["X-Destination-Peer-Id"]).toBe(
      "ee".repeat(32),
    );
    expect(captured.init?.method).toBe("POST");
  });

  it("throws on non-200", async () => {
    const fetchImpl = mockFetch(() => new Response("dial error", { status: 502 }));
    const client = new AxlClient({ baseUrl: "http://x", fetchImpl });
    await expect(client.send("a".repeat(64), new Uint8Array([1]))).rejects.toMatchObject({
      name: "AxlClientError",
      status: 502,
    });
  });
});

describe("AxlClient.recv", () => {
  it("returns null on 204", async () => {
    const fetchImpl = mockFetch(() => new Response(null, { status: 204 }));
    const client = new AxlClient({ baseUrl: "http://x", fetchImpl });
    expect(await client.recv()).toBeNull();
  });

  it("returns body + from header on 200", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(new Uint8Array([7, 8, 9]), {
          status: 200,
          headers: { "X-From-Peer-Id": "ee".repeat(32) },
        }),
    );
    const client = new AxlClient({ baseUrl: "http://x", fetchImpl });
    const msg = await client.recv();
    expect(msg).not.toBeNull();
    expect(msg?.fromHeader).toBe("ee".repeat(32));
    expect(Array.from(msg?.body ?? [])).toEqual([7, 8, 9]);
  });

  it("throws on unexpected status", async () => {
    const fetchImpl = mockFetch(() => new Response("oops", { status: 500 }));
    const client = new AxlClient({ baseUrl: "http://x", fetchImpl });
    await expect(client.recv()).rejects.toBeInstanceOf(AxlClientError);
  });
});
