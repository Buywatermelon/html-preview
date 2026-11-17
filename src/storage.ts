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
}
