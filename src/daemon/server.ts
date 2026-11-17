import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  SessionDiscovery,
  type PrepareUploadRequest,
  type PrepareUploadResponse,
} from "./discovery";
import {
  atomicWriteSecureJson,
  DAEMON_VERSION,
  ensureHostIdentity,
  ensureSecureDir,
  loadServerCredentials,
  resolveDaemonPaths,
  type DaemonPaths,
  type HostIdentity,
  type ServerCredential,
} from "./host-identity";
import { createDefaultRegistry, type AdapterRegistry } from "./registry";
import { procStartTime } from "./session-files";
import {
  DaemonServerConnection,
  type DaemonConnectionOptions,
  type ServerConnectionHealth,
} from "./transport";

const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MiB x 3 rotation

interface DaemonLockMetadata {
  pid: number;
  startTime?: string;
  instanceId: string;
  socketPath: string;
  createdAt: string;
}

const inProcessLocks = new Map<string, string>();

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function readLockMeta(lockFile: string): DaemonLockMetadata | null {
  try {
    if (!existsSync(lockFile)) return null;
    const raw = JSON.parse(readFileSync(lockFile, "utf-8")) as Partial<DaemonLockMetadata>;
    if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid)) return null;
    return {
      pid: raw.pid,
      startTime: typeof raw.startTime === "string" ? raw.startTime : undefined,
      instanceId: typeof raw.instanceId === "string" ? raw.instanceId : "",
      socketPath: typeof raw.socketPath === "string" ? raw.socketPath : "",
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    };
  } catch {
    return null;
  }
}

function isDaemonLockAlive(lockFile: string, meta: DaemonLockMetadata | null): boolean {
  if (!meta || !Number.isInteger(meta.pid) || meta.pid < 1) return false;
  const normLock = resolvePath(lockFile);
  if (meta.pid === process.pid) {
    return Boolean(meta.instanceId && inProcessLocks.get(normLock) === meta.instanceId);
  }
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${meta.pid}/stat`, "utf-8");
      const closeIdx = raw.lastIndexOf(")");
      if (closeIdx >= 0) {
        const state = raw.slice(closeIdx + 2).trim().split(/\s+/)[0];
        if (state === "Z" || state === "X") return false;
      }
    } catch {
      return false;
    }
  }
  try {
    process.kill(meta.pid, 0);
  } catch {
    return false;
  }
  if (meta.startTime) {
    const currentStart = procStartTime(meta.pid);
    if (currentStart && currentStart !== meta.startTime) {
      return false;
    }
  }
  return true;
}

function probeRawSocketConnect(
  socketPath: string,
  timeoutMs = 400,
): Promise<"listening" | "dead"> {
  if (!existsSync(socketPath)) return Promise.resolve("dead");
  return new Promise(resolve => {
    let settled = false;
    const finish = (state: "listening" | "dead") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        // Ignore
      }
      resolve(state);
    };
    const sock = createConnection({ path: socketPath });
    const timer = setTimeout(() => finish("listening"), timeoutMs);
    timer.unref?.();
    sock.once("connect", () => finish("listening"));
    sock.once("error", (err: NodeJS.ErrnoException) => {
      if (
        err.code === "ECONNREFUSED" ||
        err.code === "ENOENT" ||
        err.code === "ENOTSOCK"
      ) {
        finish("dead");
      } else {
        finish("listening");
      }
    });
  });
}

export interface DaemonHealthPayload {
  ok: true;
  pid: number;
  version: string;
  hostId: string;
  hostName: string;
  socketPath: string;
  uptimeSec: number;
  servers: ServerConnectionHealth[];
  availableAgents: string[];
}

export class DaemonAlreadyRunningError extends Error {
  constructor(
    public readonly socketPath: string,
    public readonly existingHealth: DaemonHealthPayload,
  ) {
    super(
      `html-preview daemon is already running (pid ${existingHealth.pid}, socket ${socketPath})`,
    );
    this.name = "DaemonAlreadyRunningError";
  }
}

export function probeUnixSocketHealth(
  socketPath: string,
  timeoutMs = 1500,
): Promise<DaemonHealthPayload | null> {
  if (!existsSync(socketPath)) return Promise.resolve(null);
  return new Promise(resolve => {
    const req = httpRequest(
      {
        socketPath,
        path: "/v1/health",
        method: "GET",
        timeout: timeoutMs,
      },
      res => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(
              Buffer.concat(chunks).toString("utf-8"),
            ) as DaemonHealthPayload;
            resolve(parsed && parsed.ok === true ? parsed : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => {
      resolve(null);
    });
    req.end();
  });
}

function appendRotatingLog(logFile: string, level: string, msg: string): void {
  try {
    ensureSecureDir(dirname(logFile));
    if (existsSync(logFile)) {
      const st = statSync(logFile);
      if (st.size >= MAX_LOG_BYTES) {
        const rot2 = `${logFile}.2`;
        const rot1 = `${logFile}.1`;
        if (existsSync(rot1)) {
          try {
            renameSync(rot1, rot2);
          } catch {
            // Ignore
          }
        }
        try {
          renameSync(logFile, rot1);
        } catch {
          // Ignore
        }
      }
    }
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}\n`;
    appendFileSync(logFile, line, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Never crash daemon on log write failure
  }
}

function readJsonBody<T>(req: IncomingMessage, maxBytes = 65_536): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export interface HostDaemonOptions {
  paths?: Partial<DaemonPaths>;
  env?: NodeJS.ProcessEnv;
  preferredHostName?: string;
  explicitCredentials?: ServerCredential[];
  registry?: AdapterRegistry;
  discovery?: SessionDiscovery;
  connectWebSocket?: boolean;
  connectionOverrides?: Partial<
    Omit<
      DaemonConnectionOptions,
      "credential" | "identity" | "envelopeDir" | "handoffDir" | "registry"
    >
  >;
  credentialsPollMs?: number;
  logToStderr?: boolean;
  onShutdownRequested?: () => void;
}

export class HostDaemon {
  public readonly paths: DaemonPaths;
  private readonly env: NodeJS.ProcessEnv;
  private readonly registry: AdapterRegistry;
  private readonly discovery: SessionDiscovery;
  private readonly explicitCredentials?: ServerCredential[];
  private readonly connectWebSocket: boolean;
  private readonly connectionOverrides: NonNullable<HostDaemonOptions["connectionOverrides"]>;
  private readonly credentialsPollMs: number;
  private readonly logToStderr: boolean;
  private readonly onShutdownRequested?: () => void;

  private readonly instanceId = randomUUID();
  private identity: HostIdentity;
  private startedAtMs = 0;
  private running = false;
  private ownsLock = false;
  private ownsSocket = false;
  private boundSocketIno: number | bigint | null = null;
  private ownsPidFile = false;
  private socketServer: Server | null = null;
  private credWatchTimer: ReturnType<typeof setInterval> | null = null;
  private lastCredMtimeMs = -1;
  private readonly connections = new Map<string, DaemonServerConnection>();

  private cachedAgents: string[] | null = null;
  private cachedAgentsAtMs = 0;
  private agentsRefreshPromise: Promise<string[]> | null = null;

  constructor(opts?: HostDaemonOptions) {
    this.env = opts?.env ?? process.env;
    const basePaths = resolveDaemonPaths({
      configDir: opts?.paths?.configDir,
      stateDir: opts?.paths?.stateDir,
      dataDir: opts?.paths?.dataDir,
      socketPath: opts?.paths?.socketPath,
      logFile: opts?.paths?.logFile,
      env: this.env,
    });
    this.paths = { ...basePaths, ...(opts?.paths ?? {}) };
    this.identity = ensureHostIdentity(this.paths.configDir, opts?.preferredHostName);
    this.registry = opts?.registry ?? createDefaultRegistry({ env: this.env });
    this.discovery = opts?.discovery ?? new SessionDiscovery();
    this.explicitCredentials = opts?.explicitCredentials;
    this.connectWebSocket = opts?.connectWebSocket !== false;
    this.connectionOverrides = opts?.connectionOverrides ?? {};
    this.credentialsPollMs = opts?.credentialsPollMs ?? 3_000;
    this.logToStderr = opts?.logToStderr === true;
    this.onShutdownRequested = opts?.onShutdownRequested;
  }

  getIdentity(): HostIdentity {
    return this.identity;
  }

  private log = (level: "info" | "warn" | "error", msg: string): void => {
    appendRotatingLog(this.paths.logFile, level, msg);
    if (this.logToStderr) {
      process.stderr.write(`[html-preview-daemon] [${level}] ${msg}\n`);
    }
  };

  private fallbackHealthForPid(pid: number, socketPath: string): DaemonHealthPayload {
    return {
      ok: true,
      pid,
      version: DAEMON_VERSION,
      hostId: this.identity.hostId,
      hostName: this.identity.hostName,
      socketPath,
      uptimeSec: 0,
      servers: [],
      availableAgents: [],
    };
  }

  private async acquireSingleInstanceLock(): Promise<void> {
    const lockFile = this.paths.lockFile;
    const normLock = resolvePath(lockFile);
    const deadline = Date.now() + 5_000;

    while (Date.now() < deadline) {
      const myMeta: DaemonLockMetadata = {
        pid: process.pid,
        startTime: procStartTime(process.pid),
        instanceId: this.instanceId,
        socketPath: this.paths.socketPath,
        createdAt: new Date().toISOString(),
      };
      const tmpLock = `${lockFile}.${process.pid}.${this.instanceId}.tmp`;
      try {
        writeFileSync(tmpLock, `${JSON.stringify(myMeta, null, 2)}\n`, {
          encoding: "utf-8",
          mode: 0o600,
        });
        try {
          chmodSync(tmpLock, 0o600);
        } catch {
          // Ignore
        }
        linkSync(tmpLock, lockFile);
        inProcessLocks.set(normLock, this.instanceId);
        this.ownsLock = true;
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "EEXIST") {
          throw err;
        }
      } finally {
        try {
          unlinkSync(tmpLock);
        } catch {
          // Ignore
        }
      }

      const existing = readLockMeta(lockFile);
      if (isDaemonLockAlive(lockFile, existing)) {
        const peerSocket = existing!.socketPath || this.paths.socketPath;
        const waitDeadline = Math.min(deadline, Date.now() + 3_000);
        while (Date.now() < waitDeadline) {
          const live = await probeUnixSocketHealth(peerSocket, 800);
          if (live) {
            throw new DaemonAlreadyRunningError(peerSocket, live);
          }
          const latest = readLockMeta(lockFile);
          if (!isDaemonLockAlive(lockFile, latest)) {
            break;
          }
          await sleepMs(40);
        }
        const finalMeta = readLockMeta(lockFile);
        if (isDaemonLockAlive(lockFile, finalMeta)) {
          const finalSock = finalMeta!.socketPath || this.paths.socketPath;
          const live = await probeUnixSocketHealth(finalSock, 800);
          throw new DaemonAlreadyRunningError(
            finalSock,
            live ?? this.fallbackHealthForPid(finalMeta!.pid, finalSock),
          );
        }
        continue;
      }

      // Stale lock left behind by a crashed/SIGKILLed process: serialize eviction
      const evictFile = `${lockFile}.evict`;
      let evictFd: number | null = null;
      try {
        evictFd = openSync(evictFile, "wx", 0o600);
        const recheck = readLockMeta(lockFile);
        if (!isDaemonLockAlive(lockFile, recheck)) {
          try {
            unlinkSync(lockFile);
          } catch {
            // Ignore
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
          try {
            if (Date.now() - statSync(evictFile).mtimeMs > 5_000) {
              unlinkSync(evictFile);
            }
          } catch {
            // Ignore
          }
          await sleepMs(25);
          continue;
        }
        throw err;
      } finally {
        if (evictFd !== null) {
          try {
            closeSync(evictFd);
          } catch {
            // Ignore
          }
          try {
            unlinkSync(evictFile);
          } catch {
            // Ignore
          }
        }
      }
    }

    const existing = readLockMeta(lockFile);
    if (isDaemonLockAlive(lockFile, existing)) {
      const peerSocket = existing!.socketPath || this.paths.socketPath;
      throw new DaemonAlreadyRunningError(
        peerSocket,
        this.fallbackHealthForPid(existing!.pid, peerSocket),
      );
    }
    throw new Error(`Timed out acquiring daemon lock at ${lockFile}`);
  }

  private releaseSingleInstanceLock(): void {
    if (!this.ownsLock) return;
    this.ownsLock = false;
    const normLock = resolvePath(this.paths.lockFile);
    if (inProcessLocks.get(normLock) === this.instanceId) {
      inProcessLocks.delete(normLock);
    }
    try {
      const current = readLockMeta(this.paths.lockFile);
      if (current?.instanceId === this.instanceId) {
        unlinkSync(this.paths.lockFile);
      }
    } catch {
      // Ignore
    }
  }

  private async cleanupOwnedResources(): Promise<void> {
    if (this.credWatchTimer) {
      clearInterval(this.credWatchTimer);
      this.credWatchTimer = null;
    }

    if (this.socketServer) {
      const srv = this.socketServer;
      this.socketServer = null;
      await new Promise<void>(resolve => {
        srv.close(() => resolve());
      });
    }

    if (this.ownsSocket) {
      this.ownsSocket = false;
      const expectedIno = this.boundSocketIno;
      this.boundSocketIno = null;
      try {
        if (existsSync(this.paths.socketPath)) {
          const currentIno = statSync(this.paths.socketPath).ino;
          if (expectedIno === null || currentIno === expectedIno) {
            unlinkSync(this.paths.socketPath);
          }
        }
      } catch {
        // Ignore
      }
    }

    if (this.ownsPidFile) {
      this.ownsPidFile = false;
      try {
        if (existsSync(this.paths.pidFile)) {
          const pidText = readFileSync(this.paths.pidFile, "utf-8").trim();
          if (pidText === String(process.pid)) {
            unlinkSync(this.paths.pidFile);
          }
        }
      } catch {
        // Ignore
      }
    }

    // Release state-dir lock AFTER socket & pid cleanup so concurrent restarts never collide
    this.releaseSingleInstanceLock();
  }

  async start(): Promise<void> {
    if (this.running) return;

    ensureSecureDir(this.paths.configDir);
    ensureSecureDir(this.paths.stateDir);
    ensureSecureDir(dirname(this.paths.lockFile));
    ensureSecureDir(dirname(this.paths.socketPath));
    ensureSecureDir(this.paths.envelopeDir);
    ensureSecureDir(this.paths.handoffDir);

    // Fast-path check before acquiring lock if a healthy daemon is already answering
    const live = await probeUnixSocketHealth(this.paths.socketPath, 800);
    if (live) {
      throw new DaemonAlreadyRunningError(this.paths.socketPath, live);
    }

    await this.acquireSingleInstanceLock();

    try {
      await this.bindUnixSocketServer();
      this.startedAtMs = Date.now();
      this.running = true;

      // Warm available agent CLI probes in background so `/v1/health` responds in <5ms
      void this.refreshAvailableAgents().catch(() => {});

      writeFileSync(this.paths.pidFile, `${process.pid}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
      this.ownsPidFile = true;
      try {
        chmodSync(this.paths.pidFile, 0o600);
      } catch {
        // Ignore
      }

      await this.reloadConfiguration();

      if (!this.explicitCredentials) {
        this.credWatchTimer = setInterval(() => {
          void this.checkCredentialsFileChanged();
        }, this.credentialsPollMs);
        this.credWatchTimer.unref?.();
      }

      this.persistStateSnapshot();
      this.log(
        "info",
        `Daemon started (pid=${process.pid}, hostId=${this.identity.hostId}, hostName="${this.identity.hostName}", sock=${this.paths.socketPath}, servers=${this.connections.size})`,
      );
    } catch (err) {
      this.running = false;
      const stops = [...this.connections.values()].map(c => c.stop(2_000));
      this.connections.clear();
      await Promise.allSettled(stops);
      await this.cleanupOwnedResources();
      throw err;
    }
  }

  async stop(gracefulTimeoutMs = 15_000): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.log("info", "Stopping daemon...");

    if (this.credWatchTimer) {
      clearInterval(this.credWatchTimer);
      this.credWatchTimer = null;
    }

    if (this.socketServer) {
      const srv = this.socketServer;
      this.socketServer = null;
      await new Promise<void>(resolve => {
        srv.close(() => resolve());
      });
    }

    const stops = [...this.connections.values()].map(c => c.stop(gracefulTimeoutMs));
    this.connections.clear();
    await Promise.allSettled(stops);

    await this.cleanupOwnedResources();
    this.log("info", "Daemon stopped cleanly");
  }

  private async checkCredentialsFileChanged(): Promise<void> {
    if (!this.running || this.explicitCredentials) return;
    let mtime = 0;
    if (existsSync(this.paths.credentialsFile)) {
      try {
        mtime = statSync(this.paths.credentialsFile).mtimeMs;
      } catch {
        mtime = 0;
      }
    }
    if (mtime !== this.lastCredMtimeMs) {
      await this.reloadConfiguration();
    }
  }

  async reloadConfiguration(): Promise<{ serverCount: number }> {
    this.identity = ensureHostIdentity(this.paths.configDir);

    let creds: ServerCredential[];
    if (this.explicitCredentials) {
      creds = this.explicitCredentials;
    } else {
      const loaded = loadServerCredentials(this.paths.configDir, this.env);
      creds = loaded.credentials;
      this.lastCredMtimeMs = loaded.mtimeMs;
    }

    const desiredByUrl = new Map<string, ServerCredential>();
    for (const c of creds) {
      desiredByUrl.set(c.serverUrl.replace(/\/+$/, ""), c);
    }

    // Stop removed servers
    for (const [url, conn] of this.connections.entries()) {
      if (!desiredByUrl.has(url)) {
        this.connections.delete(url);
        await conn.stop(5_000);
      }
    }

    // Add or update active servers
    const starts: Promise<void>[] = [];
    for (const [url, cred] of desiredByUrl.entries()) {
      const existing = this.connections.get(url);
      if (existing) {
        existing.updateCredentialAndIdentity(cred.token, this.identity);
      } else {
        const conn = new DaemonServerConnection({
          credential: cred,
          identity: this.identity,
          envelopeDir: this.paths.envelopeDir,
          handoffDir: this.paths.handoffDir,
          lockDir: join(this.paths.stateDir, "locks"),
          env: this.env,
          homeDir: this.env.HOME,
          registry: this.registry,
          connectWebSocket: this.connectWebSocket,
          logger: this.log,
          ...this.connectionOverrides,
        });
        this.connections.set(url, conn);
        if (this.running) {
          starts.push(conn.start());
        }
      }
    }
    if (starts.length > 0) {
      await Promise.allSettled(starts);
    }

    this.persistStateSnapshot();
    return { serverCount: this.connections.size };
  }

  getConnection(serverUrl: string): DaemonServerConnection | undefined {
    return this.connections.get(serverUrl.replace(/\/+$/, ""));
  }

  private refreshAvailableAgents(): Promise<string[]> {
    if (this.agentsRefreshPromise) {
      return this.agentsRefreshPromise;
    }
    this.agentsRefreshPromise = (async () => {
      const available: string[] = [];
      await Promise.all(
        this.registry.list().map(async plugin => {
          const probe = await plugin.probe().catch(() => ({ available: false }));
          if (probe.available) {
            available.push(plugin.id);
          }
        }),
      );
      // Keep stable registration order
      const order = this.registry.ids();
      available.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      this.cachedAgents = available;
      this.cachedAgentsAtMs = Date.now();
      return available;
    })().finally(() => {
      this.agentsRefreshPromise = null;
    });
    return this.agentsRefreshPromise;
  }

  async getAvailableAgents(opts?: { maxWaitMs?: number }): Promise<string[]> {
    const now = Date.now();
    if (this.cachedAgents !== null) {
      if (now - this.cachedAgentsAtMs >= 30_000) {
        // Stale-while-revalidate: never block health probes when cache expires
        void this.refreshAvailableAgents().catch(() => {});
      }
      return this.cachedAgents;
    }
    const refresh = this.refreshAvailableAgents();
    if (typeof opts?.maxWaitMs === "number" && opts.maxWaitMs >= 0) {
      return Promise.race([
        refresh,
        sleepMs(opts.maxWaitMs).then(() => this.cachedAgents ?? []),
      ]);
    }
    return refresh;
  }

  async getHealth(opts?: { maxWaitMs?: number }): Promise<DaemonHealthPayload> {
    const availableAgents = await this.getAvailableAgents(opts);
    return {
      ok: true,
      pid: process.pid,
      version: DAEMON_VERSION,
      hostId: this.identity.hostId,
      hostName: this.identity.hostName,
      socketPath: this.paths.socketPath,
      uptimeSec: this.startedAtMs
        ? Math.max(0, Math.floor((Date.now() - this.startedAtMs) / 1000))
        : 0,
      servers: [...this.connections.values()].map(c => c.getHealth()),
      availableAgents,
    };
  }

  private persistStateSnapshot(): void {
    try {
      atomicWriteSecureJson(this.paths.stateFile, {
        pid: process.pid,
        version: DAEMON_VERSION,
        hostId: this.identity.hostId,
        hostName: this.identity.hostName,
        socketPath: this.paths.socketPath,
        updatedAt: new Date().toISOString(),
        servers: [...this.connections.values()].map(c => c.getHealth()),
      });
    } catch {
      // Best-effort state snapshot
    }
  }

  private listenSocketOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => {
        void this.handleSocketRequest(req, res);
      });
      const onError = (err: Error) => {
        reject(err);
      };
      srv.once("error", onError);
      srv.listen(this.paths.socketPath, () => {
        srv.off("error", onError);
        try {
          chmodSync(this.paths.socketPath, 0o600);
        } catch {
          // Ignore
        }
        this.socketServer = srv;
        this.ownsSocket = true;
        try {
          this.boundSocketIno = statSync(this.paths.socketPath).ino;
        } catch {
          this.boundSocketIno = null;
        }
        resolve();
      });
    });
  }

  private async bindUnixSocketServer(): Promise<void> {
    try {
      await this.listenSocketOnce();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EADDRINUSE") {
        throw err;
      }
    }

    // Never unlink an active socket: check kernel listener first
    const sockState = await probeRawSocketConnect(this.paths.socketPath, 500);
    if (sockState === "listening") {
      const live = await probeUnixSocketHealth(this.paths.socketPath, 2_000);
      throw new DaemonAlreadyRunningError(
        this.paths.socketPath,
        live ?? this.fallbackHealthForPid(0, this.paths.socketPath),
      );
    }

    // Socket inode is confirmed dead (ECONNREFUSED/ENOENT/ENOTSOCK) while holding daemon.lock
    try {
      unlinkSync(this.paths.socketPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }
    await this.listenSocketOnce();
  }

  private async handleSocketRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/v1/health") {
        const wantFull = url.searchParams.get("full") === "1";
        const health = await this.getHealth({ maxWaitMs: wantFull ? 2_500 : 50 });
        sendJson(res, 200, health);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/sessions") {
        const adapterId = url.searchParams.get("adapter")?.trim() || undefined;
        const cwd = url.searchParams.get("cwd")?.trim() || undefined;
        const rawLimit = Number(url.searchParams.get("limit") || "20");
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(100, Math.floor(rawLimit)) : 20;
        const sessions = await this.registry.listSessions({ adapterId, cwd, limit });
        sendJson(res, 200, { ok: true, sessions });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/prepare-upload") {
        const body = await readJsonBody<PrepareUploadRequest>(req);
        const prepared: PrepareUploadResponse = await this.discovery.prepareUpload(
          this.identity,
          body,
        );
        sendJson(res, 200, prepared);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/reload") {
        const info = await this.reloadConfiguration();
        const health = await this.getHealth();
        sendJson(res, 200, { ok: true, ...info, health });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/drain") {
        const body = await readJsonBody<{ includeDeferred?: boolean }>(req);
        let claimed = 0;
        for (const conn of this.connections.values()) {
          claimed += await conn.drainOnce(body?.includeDeferred === true);
        }
        sendJson(res, 200, { ok: true, claimed });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/release-session") {
        const body = await readJsonBody<{ adapterId?: string; sessionId?: string; waitMs?: number }>(req);
        const adapterId = (body.adapterId || "").trim();
        const sessionId = (body.sessionId || "").trim();
        if (!adapterId || !sessionId) {
          sendJson(res, 400, { error: "adapterId and sessionId are required" });
          return;
        }
        const results = await Promise.all(
          [...this.connections.values()].map(c => c.releaseForTerminal(adapterId, sessionId, body.waitMs)),
        );
        const released = results.every(r => r.released);
        sendJson(res, 200, { ok: true, released, results });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/shutdown") {
        sendJson(res, 200, { ok: true, stopping: true });
        setImmediate(() => {
          void this.stop().finally(() => {
            this.onShutdownRequested?.();
          });
        });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
