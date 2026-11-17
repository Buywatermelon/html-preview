import { randomUUID } from "node:crypto";
import type { AcpAgentStatus, AcpClientCommand, AcpClientFrame, AcpServerFrame } from "../acp-types";
import { AcpSessionManager, TERMINAL_MESSAGE } from "./acp-sessions";
import { buildAnchorPrompt } from "./prompt";
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import type {
  CodingAgentAdapter,
  InteractionEnvelope,
  SessionBinding,
} from "../interact-types";
import {
  DAEMON_VERSION,
  normalizeServerUrl,
  type HostIdentity,
  type ServerCredential,
} from "./host-identity";
import {
  adapterDisplayLabel,
  encodeOpaqueBinding,
  unpackEnvelopeBinding,
} from "./opaque-binding";
import type { AdapterRegistry } from "./registry";

const SAFE_ENVELOPE_ID_RE = /^[A-Za-z0-9_.-]+$/;
const SEVEN_DAYS_MS = 7 * 24 * 3600_000;

export class SessionDeferredError extends Error {
  constructor(
    message: string,
    public readonly sessionKey: string,
    public readonly canTakeover = false,
  ) {
    super(message);
    this.name = "SessionDeferredError";
  }
}

export type ConnectionState =
  | "stopped"
  | "connecting"
  | "online"
  | "backoff_wait"
  | "auth_revoked";

export interface ServerConnectionHealth {
  url: string;
  state: ConnectionState;
  connected: boolean;
  lastPongAt: string | null;
  activeDeliveries: number;
  reconnectAttempts: number;
  lastError: string | null;
}

export async function resolveAvailableAgent(
  registry: AdapterRegistry,
): Promise<CodingAgentAdapter | undefined> {
  for (const adapter of registry.list()) {
    const probe = await adapter.probe().catch(() => ({ available: false }));
    if (probe.available) return adapter;
  }
  return undefined;
}

export interface DaemonConnectionOptions {
  credential: ServerCredential;
  identity: HostIdentity;
  envelopeDir: string;
  handoffDir: string;
  lockDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  registry: AdapterRegistry;
  connectWebSocket?: boolean;
  fetchImpl?: typeof fetch;
  nowFn?: () => number;
  logger?: (level: "info" | "warn" | "error", msg: string) => void;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  idleSweepIntervalMs?: number;
  leaseSeconds?: number;
  leaseRenewIntervalMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  disableJitter?: boolean;
  clockTickIntervalMs?: number;
  clockJumpThresholdMs?: number;
  wakeReconnectDelayMs?: number;
}

export class DaemonServerConnection {
  public readonly serverUrl: string;
  private token: string;
  private identity: HostIdentity;
  private readonly envelopeDir: string;
  private readonly handoffDir: string;
  private readonly registry: AdapterRegistry;
  private readonly connectWebSocket: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly nowFn: () => number;
  private readonly log: (level: "info" | "warn" | "error", msg: string) => void;

  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly idleSweepIntervalMs: number;
  private readonly leaseSeconds: number;
  private readonly leaseRenewIntervalMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly disableJitter: boolean;
  private readonly clockTickIntervalMs: number;
  private readonly clockJumpThresholdMs: number;
  private readonly wakeReconnectDelayMs: number;

  private state: ConnectionState = "stopped";
  private running = false;
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private lastPongAt: string | null = null;
  private lastError: string | null = null;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null;
  private clockWatchTimer: ReturnType<typeof setInterval> | null = null;
  private lastClockMs = 0;

  private readonly acp: AcpSessionManager;
  private readonly sessionTurns = new Map<string, InteractionEnvelope>();
  private readonly documents = new Map<string, { documentId: string; version?: number }>();
  private readonly snapshots = new Map<string, string>();
  private activeClaim: Promise<number> | null = null;
  private pendingReclaim = false;
  private pendingIncludeDeferred = false;
  private readonly inFlightControllers = new Map<string, AbortController>();
  private readonly inFlightPromises = new Set<Promise<void>>();
  private readonly sessionQueues = new Map<string, Promise<void>>();

  constructor(opts: DaemonConnectionOptions) {
    this.serverUrl = normalizeServerUrl(opts.credential.serverUrl);
    this.token = opts.credential.token.trim();
    this.identity = opts.identity;
    this.envelopeDir = opts.envelopeDir;
    this.handoffDir = opts.handoffDir;
    this.registry = opts.registry;
    this.connectWebSocket = opts.connectWebSocket !== false;
    this.fetchFn = opts.fetchImpl ?? fetch;
    this.nowFn = opts.nowFn ?? Date.now;
    this.log = opts.logger ?? (() => {});

    this.pingIntervalMs = opts.pingIntervalMs ?? 25_000;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? 10_000;
    this.idleSweepIntervalMs = opts.idleSweepIntervalMs ?? 180_000;
    this.leaseSeconds = opts.leaseSeconds ?? 90;
    this.leaseRenewIntervalMs = opts.leaseRenewIntervalMs ?? 45_000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000;
    this.disableJitter = opts.disableJitter === true;
    this.clockTickIntervalMs = opts.clockTickIntervalMs ?? 2_000;
    this.clockJumpThresholdMs = opts.clockJumpThresholdMs ?? 7_000;
    this.wakeReconnectDelayMs = opts.wakeReconnectDelayMs ?? 300;
    this.acp = new AcpSessionManager({
      emit: frame => { this.sendWsFrame(frame); },
      env: opts.env,
      homeDir: opts.homeDir ?? opts.env?.HOME,
      lockDir: opts.lockDir ?? join(opts.handoffDir, "locks"),
      bridgeDir: join(opts.handoffDir, "bridges"),
      onAttention: key => {
        const env = this.sessionTurns.get(key);
        if (env) void this.postDaemonEvent({ interactionId: env.interactionId, fencingToken: env.fencingToken,
          eventKey: `${env.deliveryId}:permission`, kind: "needs_attention", summary: "Agent 请求权限，请打开会话处理" }).catch(() => {});
      },
      onSessionAvailable: () => {
        if (this.running && this.state !== "auth_revoked") {
          void this.drainOnce(true).catch(() => 0);
        }
      },
    });
  }

  async releaseForTerminal(
    adapterId: string,
    sessionId: string,
    waitMs?: number,
  ): Promise<{ released: boolean; status: string }> {
    return this.acp.releaseForTerminal(adapterId, sessionId, waitMs);
  }

  getHealth(): ServerConnectionHealth {
    return {
      url: this.serverUrl,
      state: this.state,
      connected: this.state === "online",
      lastPongAt: this.lastPongAt,
      activeDeliveries: this.inFlightPromises.size,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
    };
  }

  updateCredentialAndIdentity(token: string, identity: HostIdentity): void {
    const cleanToken = token.trim();
    const tokenChanged = cleanToken !== this.token;
    const identityChanged =
      identity.hostId !== this.identity.hostId ||
      identity.hostName !== this.identity.hostName;
    this.token = cleanToken;
    this.identity = identity;

    if (!this.running) return;

    if (tokenChanged || identityChanged || this.state === "auth_revoked") {
      this.log("info", `[${this.serverUrl}] Credential/identity updated; reconnecting`);
      this.state = "connecting";
      this.reconnectAttempts = 0;
      this.lastError = null;
      this.teardownSocket();
      this.clearReconnectTimer();
      if (this.connectWebSocket) {
        this.openWebSocket();
      } else {
        this.state = "online";
        void this.drainOnce().catch(() => 0);
      }
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.ensureEnvelopeDir();
    this.cleanStaleEnvelopes();

    this.lastClockMs = this.nowFn();
    if (this.connectWebSocket) {
      this.openWebSocket();
      this.clockWatchTimer = setInterval(() => {
        this.checkClockJump();
      }, this.clockTickIntervalMs);
      this.clockWatchTimer.unref?.();
    } else {
      this.state = "online";
    }

    this.idleSweepTimer = setInterval(() => {
      if (this.state !== "auth_revoked" && this.running) {
        void this.drainOnce().catch(() => 0);
      }
    }, this.idleSweepIntervalMs);
    this.idleSweepTimer.unref?.();

    await this.drainOnce().catch(() => 0);
  }

  async stop(gracefulTimeoutMs = 15_000): Promise<void> {
    this.running = false;
    this.state = "stopped";
    this.clearReconnectTimer();
    this.clearHeartbeatTimers();
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = null;
    }
    if (this.clockWatchTimer) {
      clearInterval(this.clockWatchTimer);
      this.clockWatchTimer = null;
    }
    this.teardownSocket(1000, "Daemon stopping");
    await this.acp.close();

    if (this.inFlightPromises.size > 0) {
      const waitAll = Promise.allSettled([...this.inFlightPromises]);
      let timedOut = false;
      await Promise.race([
        waitAll,
        new Promise<void>(resolve => {
          const t = setTimeout(() => {
            timedOut = true;
            resolve();
          }, gracefulTimeoutMs);
          t.unref?.();
        }),
      ]);
      if (timedOut) {
        for (const ctrl of this.inFlightControllers.values()) {
          ctrl.abort();
        }
        await Promise.allSettled([...this.inFlightPromises]);
      }
    }
  }

  /**
   * Checks whether wall-clock jumped forward across a lid-closed sleep/resume cycle (PLAN.md §1.3).
   * Public so deterministic tests can also invoke it with a synthetic clock advance.
   */
  public checkClockJump(overrideNowMs?: number): boolean {
    const now = typeof overrideNowMs === "number" ? overrideNowMs : this.nowFn();
    const delta = now - this.lastClockMs;
    this.lastClockMs = now;

    if (!this.running || !this.connectWebSocket || this.state === "auth_revoked") {
      return false;
    }
    if (delta > this.clockJumpThresholdMs) {
      this.log(
        "info",
        `[${this.serverUrl}] System wake detected (clock jump ${delta}ms); reconnecting immediately`,
      );
      this.reconnectAttempts = 0;
      this.clearReconnectTimer();
      this.teardownSocket();
      this.state = "backoff_wait";
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.openWebSocket();
      }, this.wakeReconnectDelayMs);
      this.reconnectTimer.unref?.();
      return true;
    }
    return false;
  }

  private ensureEnvelopeDir(): void {
    mkdirSync(this.envelopeDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.envelopeDir, 0o700);
    } catch {
      // Ignore
    }
  }

  private cleanStaleEnvelopes(): void {
    if (!existsSync(this.envelopeDir)) return;
    const cutoff = this.nowFn() - SEVEN_DAYS_MS;
    try {
      for (const name of readdirSync(this.envelopeDir)) {
        if (!name.endsWith(".json")) continue;
        const full = join(this.envelopeDir, name);
        const st = statSync(full);
        if (st.mtimeMs < cutoff) {
          unlinkSync(full);
        }
      }
    } catch {
      // Best-effort cleanup
    }
  }

  private writeEnvelopeFile(envelope: InteractionEnvelope): string {
    if (!SAFE_ENVELOPE_ID_RE.test(envelope.interactionId)) {
      throw new Error(`Unsafe interactionId: ${envelope.interactionId}`);
    }
    this.ensureEnvelopeDir();
    const filePath = join(this.envelopeDir, `${envelope.interactionId}.json`);
    const payload = {
      ...envelope,
      replyCommandHint: `html-preview reply ${envelope.interactionId} --text "..."`,
    };
    writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Ignore
    }
    return filePath;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHeartbeatTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimeoutTimer) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }
  }

  private teardownSocket(code?: number, reason?: string): void {
    this.clearHeartbeatTimers();
    if (!this.ws) return;
    const sock = this.ws;
    this.ws = null;
    sock.removeAllListeners();
    // Prevent unhandled nextTick error when closing/terminating a CONNECTING ws instance
    sock.on("error", () => {});
    try {
      if (code && sock.readyState === WebSocket.OPEN) {
        sock.close(code, reason);
      } else {
        sock.terminate();
      }
    } catch {
      // Ignore
    }
  }

  private enterAuthRevoked(reason: string): void {
    this.lastError = reason;
    this.state = "auth_revoked";
    this.clearReconnectTimer();
    this.teardownSocket();
    this.log(
      "warn",
      `[${this.serverUrl}] Device token unauthorized/revoked (${reason}); pausing reconnect until re-login`,
    );
  }

  private openWebSocket(): void {
    if (!this.running || !this.connectWebSocket || this.state === "auth_revoked") return;

    this.clearReconnectTimer();
    this.teardownSocket();
    this.state = "connecting";

    const wsBase = this.serverUrl
      .replace(/^http:/i, "ws:")
      .replace(/^https:/i, "wss:");
    const qs = new URLSearchParams({
      role: "daemon",
      host_id: this.identity.hostId,
      host_name: this.identity.hostName,
      ver: DAEMON_VERSION,
    });
    const wsUrl = `${wsBase}/api/events?${qs.toString()}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleReconnect();
      return;
    }

    this.ws = socket;

    socket.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      if (status === 401 || status === 403) {
        this.enterAuthRevoked(`HTTP ${status} during WebSocket handshake`);
        return;
      }
      this.lastError = `Unexpected HTTP ${status} during WebSocket handshake`;
      this.teardownSocket();
      this.scheduleReconnect();
    });

    socket.on("open", () => {
      if (this.ws !== socket) return;
      this.state = "online";
      this.reconnectAttempts = 0;
      this.lastError = null;
      this.lastPongAt = new Date(this.nowFn()).toISOString();
      this.log("info", `[${this.serverUrl}] Connected as ${this.identity.hostName} (${this.identity.hostId})`);
      this.startHeartbeat(socket);
      void this.drainOnce().catch(() => 0);
    });

    socket.on("pong", () => {
      this.markPongReceived();
    });

    socket.on("message", data => {
      const raw =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf-8")
            : String(data);
      const trimmed = raw.trim();
      this.markPongReceived();

      if (trimmed === "pong" || trimmed === "connected") {
        return;
      }
      if (trimmed === "changed") {
        void this.drainOnce().catch(() => 0);
        return;
      }
      if (trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed) as {
            type?: unknown;
            kind?: unknown;
            targetHostId?: unknown;
          };
          if (parsed.type === "acp_client_cmd" || parsed.type === "acp_permission_response") {
            void this.handleAcpFrame(parsed as AcpClientFrame);
          } else if (parsed.type === "daemon_wake") {
            if (
              typeof parsed.targetHostId === "string" &&
              parsed.targetHostId &&
              parsed.targetHostId !== this.identity.hostId
            ) {
              return;
            }
            void this.drainOnce().catch(() => 0);
          } else if (parsed.type === "interaction" && parsed.kind === "created") {
            void this.drainOnce().catch(() => 0);
          }
        } catch {
          // Ignore malformed JSON frames
        }
      }
    });

    socket.on("close", (code, reasonBuf) => {
      if (this.ws === socket) {
        this.ws = null;
      }
      this.clearHeartbeatTimers();
      const reason = reasonBuf ? reasonBuf.toString("utf-8") : "";
      if (code === 1008 || code === 4001) {
        this.enterAuthRevoked(`WS closed with ${code} (${reason || "policy violation"})`);
        return;
      }
      if (this.running && this.state !== "auth_revoked") {
        this.scheduleReconnect();
      }
    });

    socket.on("error", err => {
      this.lastError = err instanceof Error ? err.message : String(err);
      try {
        socket.terminate();
      } catch {
        // Ignore
      }
    });
  }

  sendWsFrame(frame: AcpServerFrame): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(JSON.stringify(frame)); return true; } catch { return false; }
  }

  private async agents(): Promise<AcpAgentStatus[]> {
    return Promise.all(this.registry.list().map(async a => ({ id: a.id, name: a.displayName,
      readOnly: ["codex", "agy", "claude"].includes(a.id), ...await a.probe().catch(() => ({ available: false, reason: "Probe failed" })) })));
  }

  private async json<T>(path: string): Promise<T> {
    const res = await this.fetchFn(`${this.serverUrl}${path}`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`Cannot load document (HTTP ${res.status})`);
    return res.json() as Promise<T>;
  }

  private async snapshot(documentId: string, version?: number, entryPath = "index.html"): Promise<string> {
    const catalog = await this.json<{ archives: Array<{ id: string; publicId: string; versions: Array<{ version: number }> }> }>("/api/catalog");
    const doc = catalog.archives.find(d => d.id === documentId);
    if (!doc) throw new Error("Document not found");
    const v = version || doc.versions.at(-1)?.version;
    if (!v || !doc.versions.some(item => item.version === v)) throw new Error("Version not found");
    const path = entryPath.split("/").filter(p => p && p !== ".");
    if (!path.length || path.some(p => p === ".." || p.includes("\\")) || !/\.html?$/i.test(path.at(-1)!)) throw new Error("Invalid HTML entry path");
    const snapshotKey = `${doc.id}:${v}:${entryPath}`;
    const cached = this.snapshots.get(snapshotKey);
    if (cached) return cached;
    const res = await this.fetchFn(`${this.serverUrl}/p/${encodeURIComponent(doc.publicId)}/v${v}/${path.map(encodeURIComponent).join("/")}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`Cannot download HTML snapshot (HTTP ${res.status})`);
    const html = await res.text();
    const dir = join(this.handoffDir, "questions", randomUUID());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "index.html"), html, { mode: 0o400 });
    this.snapshots.set(snapshotKey, dir);
    return dir;
  }

  private async openFromDocument(cmd: AcpClientCommand): Promise<string> {
    if (!cmd.documentId || !/^[A-Za-z0-9_-]{1,100}$/.test(cmd.documentId)) throw new Error("documentId is required");
    const common = { clientId: cmd.clientId, requestId: cmd.requestId, afterSeq: cmd.afterSeq, epoch: cmd.epoch };
    let key: string;
    if (cmd.ephemeral) {
      const available = (await this.agents()).filter(a => a.available && a.readOnly);
      const chosen = cmd.adapterId && cmd.adapterId !== "auto" ? available.find(a => a.id === cmd.adapterId) : available[0];
      if (!chosen) throw new Error("本机没有已登录的只读 Agent");
      key = cmd.sessionKey || `question:${randomUUID()}`;
      if (!key.startsWith("question:") || !/^[A-Za-z0-9_:.\-]{1,180}$/.test(key)) throw new Error("Invalid temporary session key");
      if (cmd.sessionId && !/^[A-Za-z0-9_-]{1,160}$/.test(cmd.sessionId)) throw new Error("Invalid session ID");
      await this.acp.open({ ...common, sessionKey: key, sessionId: cmd.sessionId, adapterId: chosen.id,
        cwd: await this.snapshot(cmd.documentId, cmd.version, cmd.anchor?.entryPath), readOnly: true });
    } else {
      const data = await this.json<{ bindings: SessionBinding[] }>(`/api/archives/${encodeURIComponent(cmd.documentId)}/interactions`);
      const raw = data.bindings.find(b => b.version <= (cmd.version || Infinity));
      if (!raw || raw.hostId !== this.identity.hostId) throw new Error("原会话属于另一台宿主机或尚未绑定");
      const b = unpackEnvelopeBinding(raw);
      if (["auto", "adhoc", ""].includes(b.sessionRef) || !this.registry.get(b.adapterId)) throw new Error("页面尚未绑定原会话");
      key = `${b.adapterId}:${b.sessionRef}`;
      key = await this.acp.open({ ...common, sessionKey: key, sessionId: b.sessionRef, adapterId: b.adapterId, cwd: b.cwd || this.handoffDir, readOnly: false });
    }
    this.documents.set(key, { documentId: cmd.documentId, version: cmd.version });
    return key;
  }

  async handleAcpFrame(frame: AcpClientFrame): Promise<void> {
    if (frame.targetHostId !== this.identity.hostId) return;
    try {
      if (frame.type === "acp_permission_response") { this.acp.respond(frame.sessionKey, frame.permissionId, frame.outcome); return; }
      if (frame.action === "agents") {
        this.sendWsFrame({ type: "acp_session_state", status: "agents", sessionKey: "agents", agents: await this.agents(), targetClientId: frame.clientId, requestId: frame.requestId }); return;
      }
      if (frame.action === "open_session") { await this.openFromDocument(frame); return; }
      const key = frame.sessionKey;
      if (!key) throw new Error("sessionKey is required");
      if (frame.action === "unsubscribe") { if (frame.clientId) this.acp.unsubscribe(key, frame.clientId); return; }
      if (frame.action === "sync_session") {
        if (!this.acp.has(key)) await this.openFromDocument(frame);
        else await this.acp.sync(key, frame.afterSeq || 0, frame.epoch, frame.clientId || "", frame.requestId);
      } else if (frame.action === "takeover") {
        if (!this.acp.has(key)) await this.openFromDocument(frame);
        const res = await this.acp.requestTakeover(key);
        if (res.status === "ready") void this.drainOnce(true).catch(() => 0);
      } else if (frame.action === "cancel") await this.acp.cancel(key);
      else if (frame.action === "set_mode") await this.acp.setMode(key, frame.modeId || "");
      else if (frame.action === "prompt") {
        if (!frame.prompt?.trim() || frame.prompt.length > 16000) throw new Error("prompt is required (max 16000)");
        const state = this.acp.getState(key);
        if (state?.readOnly) await this.acp.prompt(key, buildAnchorPrompt(frame.prompt, frame.anchor, this.documents.get(key)));
        else throw new Error("请通过页面留言投递原会话，以保留离线队列与回执");
      }
    } catch (error) {
      this.sendWsFrame({ type: "acp_error", code: "ACP_COMMAND_FAILED", sessionKey: frame.sessionKey,
        targetClientId: frame.clientId, requestId: frame.type === "acp_client_cmd" ? frame.requestId : undefined,
        message: error instanceof Error ? error.message : String(error) });
    }
  }

  private markPongReceived(): void {
    this.lastPongAt = new Date(this.nowFn()).toISOString();
    if (this.pongTimeoutTimer) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }
  }

  private startHeartbeat(socket: WebSocket): void {
    this.clearHeartbeatTimers();
    this.pingTimer = setInterval(() => {
      if (this.ws !== socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send("ping");
      } catch {
        this.teardownSocket();
        this.scheduleReconnect();
        return;
      }
      if (!this.pongTimeoutTimer) {
        this.pongTimeoutTimer = setTimeout(() => {
          this.pongTimeoutTimer = null;
          if (this.ws === socket) {
            this.lastError = `Pong timeout after ${this.pongTimeoutMs}ms`;
            this.log("warn", `[${this.serverUrl}] Heartbeat pong timeout; reconnecting`);
            this.teardownSocket();
            this.scheduleReconnect();
          }
        }, this.pongTimeoutMs);
        this.pongTimeoutTimer.unref?.();
      }
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private scheduleReconnect(): void {
    if (!this.running || !this.connectWebSocket || this.state === "auth_revoked") return;
    if (this.reconnectTimer) return;
    this.state = "backoff_wait";
    const cap = Math.min(
      this.backoffMaxMs,
      this.backoffBaseMs * Math.pow(2, this.reconnectAttempts),
    );
    const delayMs = this.disableJitter ? cap : Math.floor(Math.random() * (cap + 1));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openWebSocket();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  async drainOnce(includeDeferred = false): Promise<number> {
    if (this.state === "auth_revoked") return 0;
    if (this.activeClaim) {
      this.pendingReclaim = true;
      if (includeDeferred) this.pendingIncludeDeferred = true;
      return this.activeClaim;
    }
    this.activeClaim = this.runClaimLoop(includeDeferred).finally(() => {
      this.activeClaim = null;
    });
    return this.activeClaim;
  }

  private async runClaimLoop(initialIncludeDeferred = false): Promise<number> {
    let claimedCount = 0;
    let nextIncludeDeferred = initialIncludeDeferred;
    do {
      this.pendingReclaim = false;
      const includeDef = nextIncludeDeferred || this.pendingIncludeDeferred;
      nextIncludeDeferred = false;
      this.pendingIncludeDeferred = false;
      const batch = await this.claimDeliveries(includeDef);
      for (const env of batch) {
        claimedCount += 1;
        this.enqueueEnvelopeExecution(env);
      }
    } while (this.pendingReclaim && this.running && this.state !== "auth_revoked");

    // Wait for currently scheduled work when called directly (e.g. drainOnce in tests)
    if (this.inFlightPromises.size > 0) {
      await Promise.allSettled([...this.inFlightPromises]);
    }
    return claimedCount;
  }

  private enqueueEnvelopeExecution(envelope: InteractionEnvelope): void {
    const unpacked = unpackEnvelopeBinding(envelope.binding);
    const sessionKey =
      unpacked.sessionRef && unpacked.sessionRef !== "adhoc" && unpacked.sessionRef !== "auto"
        ? `${unpacked.adapterId}:${unpacked.sessionRef}`
        : `thread:${envelope.threadId}`;

    // Shared executors (Codex app-server steer / Grok leader FIFO) accept new prompts during an active turn.
    const isShared = envelope.intent === "change" && this.acp.getState(sessionKey)?.shared === true;
    if (isShared) {
      const p = this.executeClaimedEnvelope(envelope);
      this.inFlightPromises.add(p);
      void p.finally(() => {
        this.inFlightPromises.delete(p);
      });
      return;
    }

    const prev = this.sessionQueues.get(sessionKey) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => this.executeClaimedEnvelope(envelope))
      .finally(() => {
        if (this.sessionQueues.get(sessionKey) === next) {
          this.sessionQueues.delete(sessionKey);
        }
      });

    this.sessionQueues.set(sessionKey, next);
    this.inFlightPromises.add(next);
    void next.finally(() => {
      this.inFlightPromises.delete(next);
    });
  }

  private async claimDeliveries(includeDeferred = false): Promise<InteractionEnvelope[]> {
    const resp = await this.fetchFn(`${this.serverUrl}/api/daemon/claim`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        hostId: this.identity.hostId,
        hostName: this.identity.hostName,
        limit: 5,
        leaseSeconds: this.leaseSeconds,
        ...(includeDeferred ? { includeDeferred: true } : {}),
      }),
    });

    if (resp.status === 401 || resp.status === 403) {
      this.enterAuthRevoked(`HTTP ${resp.status} from /api/daemon/claim`);
      return [];
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`Daemon claim failed (HTTP ${resp.status}): ${detail.slice(0, 200)}`);
    }

    const data = (await resp.json()) as
      | InteractionEnvelope[]
      | { deliveries?: InteractionEnvelope[]; envelopes?: InteractionEnvelope[] };
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.deliveries)) return data.deliveries;
    if (Array.isArray(data.envelopes)) return data.envelopes;
    return [];
  }

  private async renewLeaseOnce(
    interactionId: string,
    fencingToken: string,
    abortCtrl: AbortController,
  ): Promise<void> {
    if (abortCtrl.signal.aborted || !this.running) return;
    try {
      const resp = await this.fetchFn(`${this.serverUrl}/api/daemon/renew`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          interactionId,
          fencingToken,
          leaseSeconds: this.leaseSeconds,
        }),
      });
      if (resp.status === 409) {
        this.log(
          "warn",
          `[${this.serverUrl}] Lease superseded (409) for ${interactionId}; aborting local child`,
        );
        abortCtrl.abort();
      } else if (resp.status === 401 || resp.status === 403) {
        this.enterAuthRevoked(`HTTP ${resp.status} from /api/daemon/renew`);
        abortCtrl.abort();
      }
    } catch {
      // Transient network hiccup during renew; keep local execution running until next renew
    }
  }

  private async postDaemonEvent(payload: {
    interactionId: string;
    fencingToken: string;
    eventKey: string;
    kind:
      | "deferred"
      | "dispatched"
      | "working"
      | "replied"
      | "needs_attention"
      | "failed";
    deferSeconds?: number;
    summary?: string;
    replyText?: string;
    newVersion?: number;
    errorMessage?: string;
    displayAgent?: string;
    effectiveAdapterId?: string;
    discoveredBinding?: {
      hostId: string;
      hostName: string;
      binding: string;
      version?: number;
    };
    receipt?: Record<string, unknown>;
  }): Promise<number> {
    const resp = await this.fetchFn(`${this.serverUrl}/api/daemon/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (resp.status === 401 || resp.status === 403) {
      this.enterAuthRevoked(`HTTP ${resp.status} from /api/daemon/events`);
      return resp.status;
    }
    if (!resp.ok && resp.status !== 409) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`Daemon event report failed (HTTP ${resp.status}): ${detail.slice(0, 200)}`);
    }
    return resp.status;
  }

  private withDaemonRuntimeContext(envelope: InteractionEnvelope): InteractionEnvelope {
    const meta = envelope.binding.adapterMeta ?? {};
    return {
      ...envelope,
      binding: {
        ...envelope.binding,
        hostId: envelope.binding.hostId || this.identity.hostId,
        hostName: envelope.binding.hostName || this.identity.hostName,
        adapterMeta: {
          daemonServerUrl: this.serverUrl,
          daemonServerToken: this.token,
          daemonHandoffDir: this.handoffDir,
          ...(meta.demoMode === true
            ? { demoServerUrl: this.serverUrl, demoToken: this.token }
            : {}),
          ...meta,
        },
      },
    };
  }

  private async executeClaimedEnvelope(rawEnvelope: InteractionEnvelope): Promise<void> {
    const abortCtrl = new AbortController();
    this.inFlightControllers.set(rawEnvelope.interactionId, abortCtrl);

    const renewTimer = setInterval(() => {
      void this.renewLeaseOnce(
        rawEnvelope.interactionId,
        rawEnvelope.fencingToken,
        abortCtrl,
      );
    }, this.leaseRenewIntervalMs);
    renewTimer.unref?.();

    try {
      const unpackedBinding = unpackEnvelopeBinding(rawEnvelope.binding);
      const envelope: InteractionEnvelope = {
        ...rawEnvelope,
        binding: unpackedBinding,
      };

      let envelopePath: string;
      try {
        envelopePath = this.writeEnvelopeFile(envelope);
      } catch (error) {
        await this.postDaemonEvent({
          interactionId: envelope.interactionId,
          fencingToken: envelope.fencingToken,
          eventKey: `${envelope.deliveryId}:envelope-error`,
          kind: "failed",
          effectiveAdapterId: envelope.binding.adapterId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const isAutoUnbound =
        envelope.binding.adapterId === "auto" || envelope.binding.adapterId === "daemon";
      let adapter: CodingAgentAdapter | undefined = isAutoUnbound
        ? undefined
        : this.registry.get(envelope.binding.adapterId);
      let activeEnvelope: InteractionEnvelope = envelope;

      if (isAutoUnbound) {
        adapter = await resolveAvailableAgent(this.registry);
        if (!adapter) {
          await this.postDaemonEvent({
            interactionId: envelope.interactionId,
            fencingToken: envelope.fencingToken,
            eventKey: `${envelope.deliveryId}:no-auto-agent`,
            kind: "failed",
            effectiveAdapterId: "auto",
            errorMessage: "本机未检测到已登录可用的 Coding Agent CLI（claude / codex / agy）",
          });
          return;
        }
        activeEnvelope = {
          ...envelope,
          binding: {
            ...envelope.binding,
            adapterId: adapter.id,
            sessionRef: envelope.binding.sessionRef || "adhoc",
          },
        };
      }

      if (!adapter) {
        await this.postDaemonEvent({
          interactionId: envelope.interactionId,
          fencingToken: envelope.fencingToken,
          eventKey: `${envelope.deliveryId}:no-adapter`,
          kind: "failed",
          effectiveAdapterId: envelope.binding.adapterId,
          errorMessage: `No coding-agent adapter registered for ${envelope.binding.adapterId}`,
        });
        return;
      }

      let progressCounter = 0;
      const runtimeEnvelope = this.withDaemonRuntimeContext(activeEnvelope);
      const source = await adapter.locateArtifactSource(runtimeEnvelope);

      const reportWorking = async (detail: string) => {
        if (abortCtrl.signal.aborted) return;
        progressCounter += 1;
        const status = await this.postDaemonEvent({
          interactionId: envelope.interactionId,
          fencingToken: envelope.fencingToken,
          eventKey: `${envelope.deliveryId}:progress:${progressCounter}:working`,
          kind: "working",
          summary: detail,
          displayAgent: adapterDisplayLabel(adapter.id),
          effectiveAdapterId: adapter.id,
        });
        if (status === 409) {
          abortCtrl.abort();
        }
      };

      try {
        const reply = await adapter.sendMessage({
          runAcp: async req => {
            const readOnly = req.readOnly;
            const key = readOnly ? `question:${req.contextKey}` : req.sessionRef ? `${req.adapterId}:${req.sessionRef}` : `author:${req.contextKey}`;
            const cwd = readOnly ? await this.snapshot(envelope.document.id, envelope.document.baseVersion, envelope.anchor?.entryPath)
              : req.cwd || (await this.snapshot(envelope.document.id, envelope.document.baseVersion));
            let actualKey = key;
            try {
              actualKey = await this.acp.open({ sessionKey: key, sessionId: readOnly ? undefined : req.sessionRef, adapterId: req.adapterId, cwd, readOnly });
              const st = this.acp.getState(actualKey);
              if (!readOnly && st?.status === "spectating") {
                throw new SessionDeferredError(st.message || TERMINAL_MESSAGE, actualKey, st.canTakeover);
              }
              await reportWorking(`正在通过 ${adapter.displayName} 会话处理…`);
              this.sessionTurns.set(actualKey, envelope);
              try {
                const result = await this.acp.prompt(actualKey, req.promptText, abortCtrl.signal);
                return {
                  replyText: result.replyText,
                  sessionRef: result.sessionId,
                  resumed: Boolean(req.sessionRef) && !readOnly,
                  receipt: { interactionId: envelope.interactionId, sessionKey: actualKey },
                };
              } catch (promptErr) {
                const afterSt = this.acp.getState(actualKey);
                if (!readOnly && afterSt?.status === "spectating") {
                  throw new SessionDeferredError(afterSt.message || TERMINAL_MESSAGE, actualKey, afterSt.canTakeover);
                }
                throw promptErr;
              } finally {
                this.sessionTurns.delete(actualKey);
              }
            } finally {
              this.sessionTurns.delete(key);
            }
          },
          envelope: runtimeEnvelope,
          envelopePath,
          source,
          abortSignal: abortCtrl.signal,
          onWorking: reportWorking,
        });

        if (abortCtrl.signal.aborted) {
          return;
        }

        const discoveredRef = (reply.sessionRef || "").trim();
        let discoveredBinding:
          | { hostId: string; hostName: string; binding: string; version?: number }
          | undefined;
        if (
          envelope.intent !== "question" &&
          (isAutoUnbound ||
            envelope.binding.sessionRef === "adhoc" ||
            Boolean(envelope.binding.adapterMeta?.handoffFromHostId)) &&
          discoveredRef
        ) {
          discoveredBinding = {
            hostId: this.identity.hostId,
            hostName: this.identity.hostName,
            binding: encodeOpaqueBinding({
              agent: { adapter: adapter.id, ref: discoveredRef },
              cwd: source.cwd ?? activeEnvelope.binding.cwd,
              sourceFile: source.sourceFile ?? activeEnvelope.binding.sourceFile,
              demoMode: activeEnvelope.binding.adapterMeta?.demoMode === true,
            }),
            version: reply.newVersion || envelope.document.baseVersion,
          };
        }

        await this.postDaemonEvent({
          interactionId: envelope.interactionId,
          fencingToken: envelope.fencingToken,
          eventKey: `${envelope.deliveryId}:final:replied`,
          kind: "replied",
          summary: reply.newVersion
            ? `已生成 v${reply.newVersion} 并回复`
            : `${this.identity.hostName} 已回复`,
          replyText: reply.replyText,
          newVersion: reply.newVersion,
          displayAgent: adapterDisplayLabel(adapter.id),
          effectiveAdapterId: adapter.id,
          discoveredBinding,
          receipt: reply.receipt,
        });
      } catch (error) {
        if (abortCtrl.signal.aborted) {
          return;
        }
        if (error instanceof SessionDeferredError) {
          await this.postDaemonEvent({
            interactionId: envelope.interactionId,
            fencingToken: envelope.fencingToken,
            eventKey: `${envelope.deliveryId}:attempt:${envelope.attempt}:deferred`,
            kind: "deferred",
            deferSeconds: 15,
            summary: error.message,
            displayAgent: adapterDisplayLabel(adapter.id),
            effectiveAdapterId: adapter.id,
            receipt: {
              interactionId: envelope.interactionId,
              sessionKey: error.sessionKey,
              canTakeover: error.canTakeover,
              deferredAt: new Date().toISOString(),
            },
          });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        await this.postDaemonEvent({
          interactionId: envelope.interactionId,
          fencingToken: envelope.fencingToken,
          eventKey: `${envelope.deliveryId}:final:failed`,
          kind: "failed",
          summary: message,
          errorMessage: message,
          displayAgent: adapterDisplayLabel(adapter.id),
          effectiveAdapterId: adapter.id,
        });
      }
    } finally {
      clearInterval(renewTimer);
      this.inFlightControllers.delete(rawEnvelope.interactionId);
    }
  }
}
