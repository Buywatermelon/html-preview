import { relayRealtimeSocketFrame, type RelayPeer } from "./ws-relay";
import { credentialUser, type Credential } from "./auth";
import { d1Database } from "./database";
import type { HostPresenceInfo } from "./interact-types";

export type SocketRole = "browser" | "daemon";

export interface SocketAttachment {
  credential: Credential | undefined;
  clientId?: string;
  role?: SocketRole;
  hostId?: string;
  hostName?: string;
  daemonVersion?: string;
  connectedAt?: string;
  lastSeenAt?: string;
}

interface NormalizedSocketAttachment {
  credential: Credential | undefined;
  role: "browser" | "daemon";
  clientId?: string;
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

function readSocketAttachment(raw: unknown): NormalizedSocketAttachment {
  const fallbackNow = new Date().toISOString();
  if (!raw || typeof raw !== "object") {
    return { credential: undefined, role: "browser", connectedAt: fallbackNow, lastSeenAt: fallbackNow };
  }
  if ("kind" in raw) {
    return {
      credential: raw as Credential,
      role: "browser",
      connectedAt: fallbackNow,
      lastSeenAt: fallbackNow,
    };
  }
  const obj = raw as {
    credential?: Credential | null;
    role?: string;
    clientId?: string;
    hostId?: string;
    hostName?: string;
    daemonVersion?: string;
    connectedAt?: string;
    lastSeenAt?: string;
  };
  const isDaemon = obj.role === "daemon";
  const connectedAt = typeof obj.connectedAt === "string" ? obj.connectedAt : fallbackNow;
  const lastSeenAt = typeof obj.lastSeenAt === "string" ? obj.lastSeenAt : connectedAt;
  return {
    credential: obj.credential ?? undefined,
    role: isDaemon ? "daemon" : "browser",
    clientId: obj.clientId,
    hostId: sanitizeHostId(obj.hostId),
    hostName: sanitizeText(obj.hostName, 80),
    daemonVersion: sanitizeText(obj.daemonVersion, 32),
    connectedAt,
    lastSeenAt,
  };
}

function aggregateOnlineHosts(entries: NormalizedSocketAttachment[]): HostPresenceInfo[] {
  const byHost = new Map<string, HostPresenceInfo>();
  for (const att of entries) {
    if (att.role !== "daemon" || !att.hostId) continue;
    const prev = byHost.get(att.hostId);
    if (!prev || att.lastSeenAt >= prev.lastSeenAt) {
      byHost.set(att.hostId, {
        hostId: att.hostId,
        hostName: att.hostName || att.hostId,
        ...(att.daemonVersion ? { daemonVersion: att.daemonVersion } : {}),
        connectedAt: prev ? (att.connectedAt < prev.connectedAt ? att.connectedAt : prev.connectedAt) : att.connectedAt,
        lastSeenAt: att.lastSeenAt,
      });
    }
  }
  return Array.from(byHost.values());
}

export class HtmlPreviewEvents {
  constructor(
    private state: DurableObjectState,
    private env: { DB: D1Database },
  ) {
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private collectCurrentOnlineHosts(excludeSocket?: WebSocket): HostPresenceInfo[] {
    const daemonAttachments: NormalizedSocketAttachment[] = [];
    for (const sock of this.state.getWebSockets()) {
      if (sock === excludeSocket) continue;
      const att = readSocketAttachment(sock.deserializeAttachment());
      if (att.role === "daemon" && att.hostId) {
        daemonAttachments.push(att);
      }
    }
    return aggregateOnlineHosts(daemonAttachments);
  }

  private broadcastHostPresenceToBrowsers(excludeSocket?: WebSocket): void {
    const hosts = this.collectCurrentOnlineHosts(excludeSocket);
    const frame = JSON.stringify({ type: "host_presence", hosts });
    for (const sock of this.state.getWebSockets()) {
      if (sock === excludeSocket) continue;
      const att = readSocketAttachment(sock.deserializeAttachment());
      if (att.role !== "browser") continue;
      try {
        sock.send(frame);
      } catch {
        // Ignore transient closed browser socket
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const reqUrl = new URL(request.url);
    const pathname = reqUrl.pathname;

    if (request.method === "GET" && pathname === "/presence") {
      const db = d1Database(this.env.DB);
      let activeBrowserCount = 0;
      const validDaemons: NormalizedSocketAttachment[] = [];
      for (const socket of this.state.getWebSockets()) {
        const att = readSocketAttachment(socket.deserializeAttachment());
        if (!(await credentialUser(db, att.credential))) {
          socket.close(1008, "Session changed");
          continue;
        }
        if (att.role === "browser") {
          activeBrowserCount++;
        } else {
          validDaemons.push(att);
        }
      }
      return Response.json({
        activeBrowserCount,
        onlineHosts: aggregateOnlineHosts(validDaemons),
      });
    }

    if (request.method === "POST") {
      if (pathname === "/revalidate") {
        const db = d1Database(this.env.DB);
        let daemonDropped = false;
        for (const socket of this.state.getWebSockets()) {
          const att = readSocketAttachment(socket.deserializeAttachment());
          if (!(await credentialUser(db, att.credential))) {
            if (att.role === "daemon" && att.hostId) daemonDropped = true;
            socket.close(1008, "Session changed");
          }
        }
        if (daemonDropped) {
          this.broadcastHostPresenceToBrowsers();
        }
        return new Response(null, { status: 204 });
      }

      const upload = await request.text();
      let targetRole =
        (request.headers.get("X-Html-Preview-Target-Role") as "browser" | "daemon" | "all" | null) ||
        "all";
      let targetHostId = sanitizeHostId(request.headers.get("X-Html-Preview-Target-Host"));

      if (upload && upload.startsWith("{")) {
        try {
          const parsed = JSON.parse(upload) as {
            type?: string;
            targetHostId?: string | null;
          };
          if (parsed.type === "daemon_wake") {
            targetRole = "daemon";
            if (!targetHostId && typeof parsed.targetHostId === "string") {
              targetHostId = sanitizeHostId(parsed.targetHostId);
            }
          } else if (parsed.type === "host_presence") {
            targetRole = "browser";
          }
        } catch {
          // Non-JSON payload
        }
      }

      const db = d1Database(this.env.DB);
      let activeBrowserCount = 0;
      const validDaemons: NormalizedSocketAttachment[] = [];

      for (const socket of this.state.getWebSockets()) {
        const att = readSocketAttachment(socket.deserializeAttachment());
        if (!(await credentialUser(db, att.credential))) {
          socket.close(1008, "Session changed");
          continue;
        }
        if (att.role === "browser") {
          activeBrowserCount++;
        } else {
          validDaemons.push(att);
        }

        let shouldSend = true;
        if (targetRole === "browser") {
          shouldSend = att.role === "browser";
        } else if (targetRole === "daemon") {
          if (att.role !== "daemon") {
            shouldSend = false;
          } else if (targetHostId) {
            shouldSend = att.hostId === targetHostId;
          }
        }

        if (!shouldSend) continue;

        try {
          if (targetRole === "all" || !upload) {
            socket.send("changed");
          }
          if (upload) socket.send(upload);
        } catch {
          socket.close(1011, "Reconnect");
        }
      }

      const onlineHosts = aggregateOnlineHosts(validDaemons);
      return new Response(null, {
        status: 204,
        headers: {
          "X-Html-Preview-Active-Browsers": String(activeBrowserCount),
          "X-Html-Preview-Online-Hosts": JSON.stringify(onlineHosts),
        },
      });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    const rawRole =
      request.headers.get("X-Html-Preview-Role") || reqUrl.searchParams.get("role") || "browser";
    const isDaemon = rawRole === "daemon";
    const role: SocketRole = isDaemon ? "daemon" : "browser";
    const hostId = isDaemon
      ? sanitizeHostId(
          request.headers.get("X-Html-Preview-Host-Id") || reqUrl.searchParams.get("host_id"),
        )
      : undefined;
    const hostName = isDaemon
      ? sanitizeText(
          request.headers.get("X-Html-Preview-Host-Name") || reqUrl.searchParams.get("host_name"),
          80,
        ) || hostId
      : undefined;
    const daemonVersion = isDaemon
      ? sanitizeText(
          request.headers.get("X-Html-Preview-Daemon-Ver") || reqUrl.searchParams.get("ver"),
          32,
        )
      : undefined;

    const tags = isDaemon
      ? hostId
        ? ["role:daemon", `host:${hostId}`]
        : ["role:daemon"]
      : ["role:browser"];
    this.state.acceptWebSocket(server, tags);

    const credential =
      (JSON.parse(request.headers.get("X-Html-Preview-Credential") || "null") as Credential | null) ??
      undefined;
    const nowIso = new Date().toISOString();
    server.serializeAttachment({
      credential,
      role,
      clientId: crypto.randomUUID(),
      ...(hostId ? { hostId } : {}),
      ...(hostName ? { hostName } : {}),
      ...(daemonVersion ? { daemonVersion } : {}),
      connectedAt: nowIso,
      lastSeenAt: nowIso,
    } satisfies SocketAttachment);
    server.send("connected");

    if (isDaemon && hostId) {
      this.broadcastHostPresenceToBrowsers();
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const att = readSocketAttachment(socket.deserializeAttachment());
    if (att.role === "daemon") socket.serializeAttachment({ ...att, lastSeenAt: new Date().toISOString() });
    const peer = (sock: WebSocket, meta = readSocketAttachment(sock.deserializeAttachment())): RelayPeer => ({
      role: meta.role, hostId: meta.hostId, clientId: meta.clientId, send: data => sock.send(data),
    });
    relayRealtimeSocketFrame(peer(socket, att), typeof message === "string" ? message : new TextDecoder().decode(message),
      () => this.state.getWebSockets().map(sock => peer(sock)));
  }

  webSocketClose(socket: WebSocket) {
    let wasDaemonHost = false;
    try {
      const att = readSocketAttachment(socket.deserializeAttachment());
      wasDaemonHost = att.role === "daemon" && Boolean(att.hostId);
    } catch {}
    try {
      socket.close();
    } catch {}
    if (wasDaemonHost) {
      this.broadcastHostPresenceToBrowsers(socket);
    }
  }

  webSocketError(socket: WebSocket) {
    this.webSocketClose(socket);
  }
}
