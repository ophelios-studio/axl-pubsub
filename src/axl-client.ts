export interface PeerInfo {
  public_key: string;
  [k: string]: unknown;
}

export interface Topology {
  our_ipv6: string;
  our_public_key: string;
  peers: PeerInfo[];
  tree: PeerInfo[];
}

export interface ReceivedMessage {
  fromHeader: string;
  body: Uint8Array;
}

export class AxlClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AxlClientError";
  }
}

export interface AxlClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class AxlClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AxlClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async topology(): Promise<Topology> {
    const res = await this.fetchImpl(`${this.baseUrl}/topology`);
    if (!res.ok) {
      throw new AxlClientError(`topology failed: ${res.status}`, res.status);
    }
    const body = (await res.json()) as Topology;
    return body;
  }

  async send(destPubkeyHex: string, body: Uint8Array): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/send`, {
      method: "POST",
      headers: {
        "X-Destination-Peer-Id": destPubkeyHex,
        "Content-Type": "application/octet-stream",
      },
      body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new AxlClientError(`send failed: ${res.status} ${detail}`.trim(), res.status);
    }
  }

  async recv(): Promise<ReceivedMessage | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/recv`);
    if (res.status === 204) return null;
    if (!res.ok) {
      throw new AxlClientError(`recv failed: ${res.status}`, res.status);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const fromHeader = res.headers.get("x-from-peer-id") ?? "";
    return { fromHeader, body: buf };
  }
}
