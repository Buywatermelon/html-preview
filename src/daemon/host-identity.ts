import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";

export const DAEMON_VERSION = "1.1.0";

const CROCKFORD_B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const HOST_ID_VALID_RE = /^hst_[A-Za-z0-9_-]{4,64}$/;

export interface HostIdentity {
  hostId: string;
  hostName: string;
  platform: string;
  arch: string;
  createdAt: string;
}

export interface ServerCredential {
  serverUrl: string;
  token: string;
}

export interface DaemonPaths {
  configDir: string;
  stateDir: string;
  dataDir: string;
  hostFile: string;
  credentialsFile: string;
  socketPath: string;
  lockFile: string;
  pidFile: string;
  stateFile: string;
  envelopeDir: string;
  handoffDir: string;
  logFile: string;
}

export function generateHostId(): string {
  const bytes = randomBytes(20);
  let suffix = "";
  for (let i = 0; i < 20; i++) {
    suffix += CROCKFORD_B32[bytes[i] & 31];
  }
  return `hst_${suffix}`;
}

export function detectDefaultHostName(platformName: string = process.platform): string {
  if (platformName === "darwin") {
    try {
      const out = execFileSync("scutil", ["--get", "ComputerName"], {
        encoding: "utf-8",
        timeout: 1200,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) return out.slice(0, 80);
    } catch {
      // Fall back to os.hostname()
    }
  }
  const raw = (hostname() || "local-host").trim();
  const short = raw.endsWith(".local") ? raw.slice(0, -6) : raw.split(".")[0] || raw;
  return (short || "local-host").slice(0, 80);
}

export function resolveDaemonPaths(opts?: {
  configDir?: string;
  stateDir?: string;
  dataDir?: string;
  socketPath?: string;
  logFile?: string;
  env?: NodeJS.ProcessEnv;
}): DaemonPaths {
  const env = opts?.env ?? process.env;
  const home = env.HOME || homedir();

  const defaultConfigDir = join(home, ".config", "html-preview");
  const defaultStateDir = join(home, ".local", "state", "html-preview");

  const configBase = env.XDG_CONFIG_HOME || join(home, ".config");
  const stateBase = env.XDG_STATE_HOME || join(home, ".local", "state");
  const dataBase = env.XDG_DATA_HOME || join(home, ".local", "share");

  const configDir = opts?.configDir || join(configBase, "html-preview");
  const stateDir = opts?.stateDir || join(stateBase, "html-preview");
  const dataDir = opts?.dataDir || join(dataBase, "html-preview");

  let socketPath =
    opts?.socketPath ||
    env.HTML_PREVIEW_DAEMON_SOCK ||
    join(stateDir, "daemon.sock");

  // Guard against Unix domain socket sun_path ~104-byte limit (PLAN.md §1.1 & §6.4)
  if (!opts?.socketPath && !env.HTML_PREVIEW_DAEMON_SOCK && Buffer.byteLength(socketPath) > 92) {
    const isIsolated =
      resolvePath(stateDir) !== resolvePath(defaultStateDir) ||
      resolvePath(configDir) !== resolvePath(defaultConfigDir);
    if (isIsolated) {
      const digest = createHash("sha256").update(stateDir).digest("hex").slice(0, 10);
      socketPath = join("/tmp", `hp-${digest}`, "d.sock");
    } else {
      const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
      socketPath = join("/tmp", `hp-${uid}`, "d.sock");
    }
  }

  const defaultLogFile =
    process.platform === "darwin" &&
    !env.XDG_STATE_HOME &&
    resolvePath(stateDir) === resolvePath(defaultStateDir)
      ? join(home, "Library", "Logs", "html-preview", "daemon.log")
      : join(stateDir, "logs", "daemon.log");

  return {
    configDir,
    stateDir,
    dataDir,
    hostFile: join(configDir, "host.json"),
    credentialsFile: join(configDir, "credentials.json"),
    socketPath,
    lockFile: join(stateDir, "daemon.lock"),
    pidFile: join(stateDir, "daemon.pid"),
    stateFile: join(stateDir, "daemon-state.json"),
    envelopeDir: join(stateDir, "envelopes"),
    handoffDir: join(stateDir, "handoff"),
    logFile: opts?.logFile || defaultLogFile,
  };
}

export function ensureSecureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirPath, 0o700);
  } catch {
    // Ignore on filesystems that don't support POSIX chmod
  }
}

export function atomicWriteSecureJson(filePath: string, data: unknown): void {
  ensureSecureDir(dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // Ignore
  }
  renameSync(tmpPath, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Ignore
  }
}

export function ensureHostIdentity(
  configDir: string,
  preferredName?: string,
): HostIdentity {
  ensureSecureDir(configDir);
  const hostFile = join(configDir, "host.json");
  const cleanPreferred = preferredName?.trim() ? preferredName.trim().slice(0, 80) : undefined;

  if (existsSync(hostFile)) {
    try {
      const parsed = JSON.parse(readFileSync(hostFile, "utf-8")) as Partial<HostIdentity>;
      if (
        typeof parsed.hostId === "string" &&
        HOST_ID_VALID_RE.test(parsed.hostId) &&
        typeof parsed.hostName === "string" &&
        parsed.hostName.trim()
      ) {
        const identity: HostIdentity = {
          hostId: parsed.hostId,
          hostName: cleanPreferred || parsed.hostName.trim().slice(0, 80),
          platform: typeof parsed.platform === "string" ? parsed.platform : process.platform,
          arch: typeof parsed.arch === "string" ? parsed.arch : process.arch,
          createdAt:
            typeof parsed.createdAt === "string" && parsed.createdAt
              ? parsed.createdAt
              : new Date().toISOString(),
        };
        if (cleanPreferred && cleanPreferred !== parsed.hostName.trim()) {
          atomicWriteSecureJson(hostFile, identity);
        }
        return identity;
      }
    } catch {
      // Regenerate corrupted host.json
    }
  }

  const identity: HostIdentity = {
    hostId: generateHostId(),
    hostName: cleanPreferred || detectDefaultHostName(),
    platform: process.platform,
    arch: process.arch,
    createdAt: new Date().toISOString(),
  };
  atomicWriteSecureJson(hostFile, identity);
  return identity;
}

export function normalizeServerUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export function loadServerCredentials(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { credentials: ServerCredential[]; mtimeMs: number } {
  const credentialsFile = join(configDir, "credentials.json");
  const byUrl = new Map<string, ServerCredential>();
  let mtimeMs = 0;

  if (existsSync(credentialsFile)) {
    try {
      mtimeMs = statSync(credentialsFile).mtimeMs;
      const raw = JSON.parse(readFileSync(credentialsFile, "utf-8")) as Record<string, unknown>;
      const serversObj =
        raw.servers && typeof raw.servers === "object" && !Array.isArray(raw.servers)
          ? (raw.servers as Record<string, unknown>)
          : raw;

      for (const [key, val] of Object.entries(serversObj)) {
        if (!key.startsWith("http://") && !key.startsWith("https://")) continue;
        if (!val || typeof val !== "object") continue;
        const entry = val as Record<string, unknown>;
        const token = typeof entry.token === "string" ? entry.token.trim() : "";
        if (!token) continue;
        const url = normalizeServerUrl(key);
        byUrl.set(url, { serverUrl: url, token });
      }
    } catch {
      // Ignore unreadable or malformed credentials file
    }
  }

  const envUrl = env.HTML_PREVIEW_URL?.trim();
  const envToken = env.HTML_PREVIEW_TOKEN?.trim();
  if (envUrl && envToken) {
    const normalized = normalizeServerUrl(envUrl);
    byUrl.set(normalized, {
      serverUrl: normalized,
      token: envToken,
    });
  }

  return {
    credentials: [...byUrl.values()],
    mtimeMs,
  };
}
