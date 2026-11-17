#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function noSuchKeyXml(key) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message>` +
    `<Key>${escapeXml(key)}</Key></Error>`
  );
}

function readRequestBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });
}

/**
 * Starts a zero-dependency local S3-compatible HTTP server backed by an in-memory Map.
 * Safe for local `wrangler dev --local` and self-hosted `src/node.ts` demos without
 * ever touching remote Cloudflare R2 or external S3 endpoints.
 *
 * @param {{ port?: number; host?: string }} [options]
 */
export async function startLocalS3Mock(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  /** @type {Map<string, { body: Buffer; contentType: string; etag: string; updatedAt: string }>} */
  const objects = new Map();

  const server = createServer(async (req, res) => {
    try {
      const method = (req.method || "GET").toUpperCase();
      const url = new URL(req.url || "/", `http://${req.headers.host || `${host}`}`);
      const trimmed = url.pathname.replace(/^\/+/, "");

      if (!trimmed || trimmed === "_health") {
        const payload = JSON.stringify({ ok: true, objectCount: objects.size });
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": String(Buffer.byteLength(payload)),
        });
        res.end(method === "HEAD" ? undefined : payload);
        return;
      }

      const rawSegments = trimmed.split("/");
      const bucket = decodeURIComponent(rawSegments[0] || "");
      const key = rawSegments
        .slice(1)
        .filter((seg, idx, arr) => !(idx === arr.length - 1 && seg === "" && arr.length === 1))
        .map(seg => decodeURIComponent(seg))
        .join("/");

      if (!key) {
        if (method === "PUT" || method === "HEAD" || method === "GET") {
          const xml =
            `<?xml version="1.0" encoding="UTF-8"?>` +
            `<ListBucketResult><Name>${escapeXml(bucket)}</Name></ListBucketResult>`;
          res.writeHead(200, {
            "Content-Type": "application/xml; charset=utf-8",
            "Content-Length": String(Buffer.byteLength(xml)),
          });
          res.end(method === "HEAD" ? undefined : xml);
          return;
        }
      }

      const storeKey = `${bucket}/${key}`;

      if (method === "PUT") {
        const body = await readRequestBody(req);
        const contentType =
          typeof req.headers["content-type"] === "string" && req.headers["content-type"].trim()
            ? req.headers["content-type"]
            : "application/octet-stream";
        const etag = `"${createHash("md5").update(body).digest("hex")}"`;
        objects.set(storeKey, {
          body,
          contentType,
          etag,
          updatedAt: new Date().toISOString(),
        });
        res.writeHead(200, {
          ETag: etag,
          "Content-Length": "0",
        });
        res.end();
        return;
      }

      if (method === "GET" || method === "HEAD") {
        const entry = objects.get(storeKey);
        if (!entry) {
          const xml = Buffer.from(noSuchKeyXml(key), "utf8");
          res.writeHead(404, {
            "Content-Type": "application/xml; charset=utf-8",
            "Content-Length": String(xml.byteLength),
          });
          res.end(method === "HEAD" ? undefined : xml);
          return;
        }
        res.writeHead(200, {
          "Content-Type": entry.contentType,
          "Content-Length": String(entry.body.byteLength),
          ETag: entry.etag,
        });
        res.end(method === "HEAD" ? undefined : entry.body);
        return;
      }

      if (method === "DELETE") {
        await readRequestBody(req);
        objects.delete(storeKey);
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal Error";
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(msg);
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(requestedPort, host, () => {
      server.removeListener("error", rejectListen);
      resolveListen(undefined);
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to bind local S3 mock server");
  }
  const port = addr.port;
  const url = `http://${host}:${port}`;

  return {
    url,
    host,
    port,
    objects,
    server,
    clear() {
      objects.clear();
    },
    close() {
      return new Promise((resolveClose, rejectClose) => {
        server.close(err => (err ? rejectClose(err) : resolveClose(undefined)));
      });
    },
  };
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  let cliPort = Number(process.env.PORT || 0);
  let cliHost = process.env.HOST || "127.0.0.1";
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--port" && process.argv[i + 1]) {
      cliPort = Number(process.argv[++i]);
    } else if (arg.startsWith("--port=")) {
      cliPort = Number(arg.slice("--port=".length));
    } else if (arg === "--host" && process.argv[i + 1]) {
      cliHost = process.argv[++i];
    } else if (arg.startsWith("--host=")) {
      cliHost = arg.slice("--host=".length);
    }
  }

  const instance = await startLocalS3Mock({ port: cliPort, host: cliHost });
  console.log(`local-s3-mock listening on ${instance.url}`);

  const shutdown = async () => {
    await instance.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
