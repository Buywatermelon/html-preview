import { relayRealtimeSocketFrame, type RelayPeer } from "./ws-relay";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { createApp } from "./app";
import { credentialUser, requestCredential, type Credential, type AuthConfig } from "./auth";
import type { Database } from "./database";
import type { HostPresenceInfo, PresenceSnapshot } from "./interact-types";
import { applyMigrations, sqliteDatabase } from "./node-db";
import type { PushDispatcher } from "./pwa";
import type { ObjectStore } from "./storage";

export interface NodePreviewServerOptions extends Omit<AuthConfig, "PUBLIC_BASE_URL"> {
  PUBLIC_BASE_URL?: string;
  port?: number;
  host?: string;
  databasePath?: string;
  store: ObjectStore;
  pushDispatcher?: PushDispatcher;
  VAPID_PUBLIC_KEY?: string;
}

export interface RunningNodePreviewServer {
  url: string;
  port: number;
  db: Database;
  sqlite: DatabaseSync;
  getActiveSocketCounts(userId: string): { browser: number; daemon: number };
  getOnlineHosts(userId: string): HostPresenceInfo[];
  close(): Promise<void>;
}

interface NodeSocketMeta {
  clientId: string;
  credential: Credential;
  role: "browser" | "daemon";
  hostId?: string;
  hostName?: string;
  daemonVersion?: string;
  connectedAt: string;
  lastSeenAt: string;
}

function sanitizeHostId(raw: string | null | undefined): string | undefined {
  const trimmed = (raw || "").trim();
  if (!trimmed || !/^[A-Za-z0-9_.-]{1,80}$/.test(trimmed)) return undefined;
  return trimmed;
}

function sanitizeText(raw: string | null | undefined, maxLen: number): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, maxLen);
  return cleaned || undefined;
}

export async function startNodePreviewServer(
  opts: NodePreviewServerOptions,
): Promise<RunningNodePreviewServer> {
  const databasePath = opts.databasePath || ":memory:";
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  const sqlite = new DatabaseSync(databasePath);
  if (databasePath !== ":memory:") {
    sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  } else {
    sqlite.exec("PRAGMA busy_timeout=5000;");
  }
  applyMigrations(sqlite);
  const db = sqliteDatabase(sqlite);

  const host = opts.host || "127.0.0.1";
  const requestedPort = opts.port ?? 0;
  const server = createServer();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(requestedPort, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (err) {
    sqlite.close();
    throw err;
  }

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : requestedPort;
  const connectHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const baseUrl = (opts.PUBLIC_BASE_URL?.trim() || `http://${connectHost}:${actualPort}`).replace(
    /\/$/,
    "",
  );

  const connections = new Map<string, Set<WebSocket>>();
  const socketMeta = new WeakMap<WebSocket, NodeSocketMeta>();
  const pending = new Set<Promise<unknown>>();

  function computeOnlineHostsSync(userId: string): HostPresenceInfo[] {
    const byHost = new Map<string, HostPresenceInfo>();
    for (const socket of connections.get(userId) || []) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const meta = socketMeta.get(socket);
      if (!meta || meta.role !== "daemon" || !meta.hostId) continue;
      const prev = byHost.get(meta.hostId);
      if (!prev || meta.lastSeenAt >= prev.lastSeenAt) {
        byHost.set(meta.hostId, {
          hostId: meta.hostId,
          hostName: meta.hostName || meta.hostId,
          ...(meta.daemonVersion ? { daemonVersion: meta.daemonVersion } : {}),
          connectedAt: prev
            ? meta.connectedAt < prev.connectedAt
              ? meta.connectedAt
              : prev.connectedAt
            : meta.connectedAt,
          lastSeenAt: meta.lastSeenAt,
        });
      }
    }
    return Array.from(byHost.values());
  }

  function broadcastHostPresenceToBrowsers(userId: string): void {
    const hosts = computeOnlineHostsSync(userId);
    const frame = JSON.stringify({ type: "host_presence", hosts });
    for (const socket of connections.get(userId) || []) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const meta = socketMeta.get(socket);
      if (!meta || meta.role !== "browser") continue;
      try {
        socket.send(frame);
      } catch {}
    }
  }

  const app = createApp({
    ...opts,
    PUBLIC_BASE_URL: baseUrl,
    db,
    store: opts.store,
    pushDispatcher: opts.pushDispatcher,
    VAPID_PUBLIC_KEY: opts.VAPID_PUBLIC_KEY,
    defer(promise) {
      const tracked = promise.catch(() => {}).finally(() => {
        pending.delete(tracked);
      });
      pending.add(tracked);
    },
    async disconnect(id) {
      let daemonDropped = false;
      for (const socket of [...(connections.get(id) || [])]) {
        const meta = socketMeta.get(socket);
        if ((await credentialUser(db, meta?.credential))?.id !== id) {
          if (meta?.role === "daemon" && meta.hostId) daemonDropped = true;
          socket.close(1008, "Session changed");
        }
      }
      if (daemonDropped) {
        broadcastHostPresenceToBrowsers(id);
      }
    },
    async presence(userId): Promise<PresenceSnapshot> {
      let activeBrowserCount = 0;
      for (const socket of [...(connections.get(userId) || [])]) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        const meta = socketMeta.get(socket);
        if ((await credentialUser(db, meta?.credential))?.id !== userId) {
          socket.close(1008, "Session changed");
          continue;
        }
        if (meta?.role === "browser") activeBrowserCount++;
      }
      return {
        activeBrowserCount,
        onlineHosts: computeOnlineHostsSync(userId),
      };
    },
    async notify(users, event, notifyOpts) {
      const activeBrowserCount: Record<string, number> = {};
      const onlineHosts: Record<string, HostPresenceInfo[]> = {};

      let targetRole = notifyOpts?.targetRole || "all";
      let targetHostId = sanitizeHostId(notifyOpts?.targetHostId ?? undefined);
      if (event) {
        if (event.type === "daemon_wake") {
          targetRole = "daemon";
          if (!targetHostId && typeof event.targetHostId === "string") {
            targetHostId = sanitizeHostId(event.targetHostId);
          }
        } else if (event.type === "host_presence") {
          targetRole = "browser";
        }
      }

      const serializedEvent = event ? JSON.stringify(event) : undefined;

      for (const id of users) {
        let browserCount = 0;
        for (const socket of [...(connections.get(id) || [])]) {
          const meta = socketMeta.get(socket);
          if ((await credentialUser(db, meta?.credential))?.id !== id) {
            socket.close(1008, "Session changed");
            continue;
          }
          if (socket.readyState !== WebSocket.OPEN) continue;

          if ((meta?.role ?? "browser") === "browser") {
            browserCount++;
          }

          let shouldSend = true;
          if (targetRole === "browser") {
            shouldSend = (meta?.role ?? "browser") === "browser";
          } else if (targetRole === "daemon") {
            if (meta?.role !== "daemon") {
              shouldSend = false;
            } else if (targetHostId) {
              shouldSend = meta.hostId === targetHostId;
            }
          }

          if (!shouldSend) continue;

          try {
            if (targetRole === "all" || !serializedEvent) {
              socket.send("changed");
            }
            if (serializedEvent) socket.send(serializedEvent);
          } catch {
            socket.close(1011, "Reconnect");
          }
        }
        activeBrowserCount[id] = browserCount;
        onlineHosts[id] = computeOnlineHostsSync(id);
      }
      return { activeBrowserCount, onlineHosts };
    },
  });

  server.on("request", async (req, res) => {
    try {
      const method = req.method || "GET";
      const body = ["GET", "HEAD"].includes(method)
        ? undefined
        : (Readable.toWeb(req) as unknown as ReadableStream);
      const request = new Request(baseUrl + (req.url || "/"), {
        method,
        headers: req.headers as HeadersInit,
        body,
        duplex: "half",
      } as RequestInit);
      const response = await app(request);
      res.statusCode = response.status;
      for (const [key, value] of response.headers) {
        if (key.toLowerCase() !== "set-cookie") res.setHeader(key, value);
      }
      for (const value of response.headers.getSetCookie()) {
        res.appendHeader("Set-Cookie", value);
      }
      if (response.body) {
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(res);
      } else {
        res.end();
      }
    } catch {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end("Request failed");
    }
  });

  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", async (req, socket, head) => {
    try {
      const parsedUrl = new URL(req.url || "/", baseUrl);
      if (parsedUrl.pathname !== "/api/events") {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      if (req.headers.origin && req.headers.origin !== baseUrl) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const credential = await requestCredential(
        new Request(parsedUrl.href, { headers: req.headers as HeadersInit }),
      );
      const user = await credentialUser(db, credential);
      if (!user || !credential) throw new Error("Sign in required");

      const rawRole = parsedUrl.searchParams.get("role");
      const isDaemon = rawRole === "daemon";
      const role: "browser" | "daemon" = isDaemon ? "daemon" : "browser";
      const hostId = isDaemon ? sanitizeHostId(parsedUrl.searchParams.get("host_id")) : undefined;
      const hostName = isDaemon
        ? sanitizeText(parsedUrl.searchParams.get("host_name"), 80) || hostId
        : undefined;
      const daemonVersion = isDaemon
        ? sanitizeText(parsedUrl.searchParams.get("ver"), 32)
        : undefined;

      sockets.handleUpgrade(req, socket, head, ws => {
        const nowIso = new Date().toISOString();
        const meta: NodeSocketMeta = {
          clientId: crypto.randomUUID(),
          credential,
          role,
          ...(hostId ? { hostId } : {}),
          ...(hostName ? { hostName } : {}),
          ...(daemonVersion ? { daemonVersion } : {}),
          connectedAt: nowIso,
          lastSeenAt: nowIso,
        };
        socketMeta.set(ws, meta);
        const own = connections.get(user.id) || new Set<WebSocket>();
        connections.set(user.id, own);
        own.add(ws);
        ws.send("connected");

        if (isDaemon && hostId) {
          broadcastHostPresenceToBrowsers(user.id);
        }

        ws.on("message", data => {
          meta.lastSeenAt = new Date().toISOString();
          const raw = String(data);
          if (raw === "ping") { ws.send("pong"); return; }
          const peer = (sock: WebSocket, m = socketMeta.get(sock)!): RelayPeer => ({
            role: m.role, hostId: m.hostId, clientId: m.clientId,
            send: payload => { if (sock.readyState !== WebSocket.OPEN) throw new Error("Closed"); sock.send(payload); },
          });
          relayRealtimeSocketFrame(peer(ws, meta), raw, () =>
            [...own].filter(sock => sock.readyState === WebSocket.OPEN).map(sock => peer(sock)));

        });
        ws.on("close", () => {
          own.delete(ws);
          if (!own.size) connections.delete(user.id);
          if (isDaemon && hostId) {
            broadcastHostPresenceToBrowsers(user.id);
          }
        });
        ws.on("error", () => ws.close());
      });
    } catch {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    }
  });

  let closePromise: Promise<void> | null = null;

  return {
    url: baseUrl,
    port: actualPort,
    db,
    sqlite,
    getActiveSocketCounts(userId: string): { browser: number; daemon: number } {
      let browser = 0;
      let daemon = 0;
      for (const socket of connections.get(userId) || []) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        if (socketMeta.get(socket)?.role === "daemon") daemon++;
        else browser++;
      }
      return { browser, daemon };
    },
    getOnlineHosts(userId: string): HostPresenceInfo[] {
      return computeOnlineHostsSync(userId);
    },
    close(): Promise<void> {
      if (!closePromise) {
        closePromise = (async () => {
          await Promise.allSettled([...pending]);
          for (const clients of connections.values()) {
            for (const socket of clients) {
              try {
                socket.close(1001, "Restarting");
              } catch {}
            }
          }
          server.closeIdleConnections?.();
          const forceTimer = setTimeout(() => {
            for (const clients of connections.values()) {
              for (const socket of clients) {
                try {
                  socket.terminate();
                } catch {}
              }
            }
            server.closeAllConnections?.();
          }, 200);
          forceTimer.unref?.();
          await new Promise<void>(resolve => {
            server.close(() => resolve());
          });
          clearTimeout(forceTimer);
          connections.clear();
          try {
            sqlite.close();
          } catch {}
        })();
      }
      return closePromise;
    },
  };
}
