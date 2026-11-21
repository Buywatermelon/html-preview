import { AwsClient } from "aws4fetch";
import { HttpError } from "./common";

export interface StorageConfig {
  S3_ENDPOINT: string;
  S3_BUCKET: string;
  S3_REGION: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_PREFIX?: string;
  S3_PATH_STYLE?: boolean | number | string;
  prefix?: string;
  pathStyle?: boolean;
}

export interface ObjectStore {
  get(key: string): Promise<Response | null>;
  put(key: string, body: Uint8Array, type: string): Promise<void>;
  delete(key: string): Promise<void>;
  deleteMany?(keys: string[]): Promise<void>;
}

export function normalizeS3Prefix(prefix?: string | null): string {
  if (!prefix) return "";
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  if (/[\x00-\x1f\x7f\\]/.test(trimmed) || trimmed.split("/").some(p => !p || p === "." || p === "..")) {
    throw new HttpError(400, "S3 Prefix 格式无效");
  }
  return `${trimmed}/`;
}

export class S3Store implements ObjectStore {
  private client: AwsClient;
  private root: string;
  public readonly prefix: string;
  public readonly pathStyle: boolean;

  constructor(config: StorageConfig) {
    for (const key of ["S3_ENDPOINT", "S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
      if (!config[key]) throw new Error(`Missing ${key}`);
    }
    const endpoint = new URL(config.S3_ENDPOINT);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("Invalid S3 endpoint");
    }
    this.prefix = normalizeS3Prefix(config.prefix ?? config.S3_PREFIX);
    const rawPathStyle = config.pathStyle ?? config.S3_PATH_STYLE;
    this.pathStyle = rawPathStyle === undefined
      ? true
      : Boolean(rawPathStyle && rawPathStyle !== "0" && rawPathStyle !== "false");
    if (this.pathStyle) {
      this.root = endpoint.href.replace(/\/$/, "") + "/" + encodeURIComponent(config.S3_BUCKET) + "/";
    } else {
      const virtualUrl = new URL(endpoint.href);
      if (!virtualUrl.hostname.toLowerCase().startsWith(`${config.S3_BUCKET.toLowerCase()}.`)) {
        virtualUrl.hostname = `${config.S3_BUCKET}.${virtualUrl.hostname}`;
      }
      this.root = virtualUrl.href.replace(/\/$/, "") + "/";
    }
    this.client = new AwsClient({
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      region: config.S3_REGION,
      service: "s3",
      retries: 2,
    });
  }

  url(key: string): string {
    return this.root + key.split("/").map(encodeURIComponent).join("/");
  }

  async request(key: string, init?: RequestInit): Promise<Response> {
    const response = await this.client.fetch(
      this.url(key),
      { ...init, redirect: "manual" },
    );
    if (!response.ok && response.status !== 404) {
      const err = new Error(`S3 request failed (${response.status})`) as Error & { status?: number };
      err.status = response.status;
      throw err;
    }
    return response;
  }

  async get(key: string): Promise<Response | null> {
    const response = await this.request(key);
    return response.status === 404 ? null : response;
  }

  async put(key: string, body: Uint8Array, type: string): Promise<void> {
    const response = await this.request(key, {
      method: "PUT",
      body: body as BodyInit,
      headers: { "Content-Type": type },
    });
    if (!response.ok) {
      const err = new Error("S3 bucket not found") as Error & { status?: number };
      err.status = response.status;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.request(key, { method: "DELETE" });
  }

  async deleteMany(keys: string[]): Promise<void> {
    const pending = [...new Set(keys)];
    const url = this.root.replace(/\/$/, "") + "?delete";
    for (let offset = 0; offset < pending.length; offset += 1000) {
      const batch = pending.slice(offset, offset + 1000);
      const xml = `<Delete><Quiet>true</Quiet>${batch.map(key => `<Object><Key>${escapeXml(key)}</Key></Object>`).join("")}</Delete>`;
      // R2 rejects DeleteObjects without Content-MD5. One call stays under the Worker subrequest cap; per-key DELETE does not.
      const body = new TextEncoder().encode(xml);
      const response = await this.client.fetch(url, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/xml", "Content-MD5": md5Base64(body) },
        redirect: "manual",
      });
      const text = await response.text();
      if (!response.ok || text.includes("<Error>")) {
        const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
        const err = new Error(code ? `S3 delete failed (${code})` : `S3 request failed (${response.status})`) as Error & { status?: number };
        err.status = response.status;
        throw err;
      }
    }
  }
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[char]!);
}

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

function md5Base64(data: Uint8Array): string {
  const bitLen = data.length * 8;
  const padded = new Uint8Array((((data.length + 8) >>> 6) + 1) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 2 ** 32), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let offset = 0; offset < padded.length; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f = 0;
      let g = 0;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const k = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
      const next = (b + rotl((a + f + k + view.getUint32(offset + g * 4, true)) >>> 0, MD5_SHIFTS[i])) >>> 0;
      a = d;
      d = c;
      c = b;
      b = next;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const digest = new DataView(out.buffer);
  digest.setUint32(0, a0, true);
  digest.setUint32(4, b0, true);
  digest.setUint32(8, c0, true);
  digest.setUint32(12, d0, true);
  let binary = "";
  for (const byte of out) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}
