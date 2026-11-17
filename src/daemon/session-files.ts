import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AcpUpdate } from "../acp-types";

export type SharedExecutorEndpoint =
  | { kind: "codex-app-server"; socketPath: string }
  | { kind: "grok-leader"; socketPath: string };

export interface SessionOwnerInspection {
  ownedByExternal: boolean;
  uncertain?: boolean;
  busy?: boolean;
  canTakeover?: boolean;
  ownerPid?: number;
  ownerStartTime?: string;
  reason?: string;
  sharedEndpoint?: SharedExecutorEndpoint;
}

export interface CooperativeLockHandle {
  pid?: number;
  release(): void;
}

export function sessionFile(
  adapter: string,
  id: string,
  cwd: string,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) return;
  if (adapter === "agy") {
    return join(home, ".gemini/antigravity-cli/brain", id, ".system_generated/logs/transcript.jsonl");
  }
  if (adapter === "claude") {
    const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
    return join(claudeDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
  }
  if (adapter === "grok") {
    const grokDir = env.GROK_HOME || join(home, ".grok");
    return join(grokDir, "sessions", encodeURIComponent(cwd), id, "updates.jsonl");
  }
  if (adapter !== "codex") return;
  const codexDir = env.CODEX_HOME || join(home, ".codex");
  const find = (dir: string, depth: number): string | undefined => {
    if (depth > 4) return;
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith(`${id}.jsonl`)) return join(dir, e.name);
        if (e.isDirectory()) {
          const f = find(join(dir, e.name), depth + 1);
          if (f) return f;
        }
      }
    } catch {}
  };
  return find(join(codexDir, "sessions"), 0);
}

export function statStamp(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    const st = statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return undefined;
  }
}

export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function procStartTime(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf-8");
      const closeIdx = raw.lastIndexOf(")");
      if (closeIdx < 0) return undefined;
      const fields = raw.slice(closeIdx + 2).trim().split(/\s+/);
      // Field 22 in /proc/[pid]/stat is index 19 after comm
      return fields[19] || undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      timeout: 800,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function sameUid(pid: number): boolean {
  const myUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (myUid === null) return true;
  if (process.platform === "linux") {
    try {
      return statSync(`/proc/${pid}`).uid === myUid;
    } catch {
      return false;
    }
  }
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "uid="], {
      timeout: 800,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return Number(out) === myUid;
  } catch {
    return false;
  }
}

function ownProcess(pid: number, roots: Set<number>): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (roots.has(pid)) return true;
  if (process.platform === "linux") {
    for (let n = 0; pid > 1 && n < 32; n++) {
      if (roots.has(pid)) return true;
      try {
        const raw = readFileSync(`/proc/${pid}/stat`, "utf-8");
        const closeIdx = raw.lastIndexOf(")");
        if (closeIdx < 0) return false;
        pid = Number(raw.slice(closeIdx + 2).trim().split(/\s+/)[1]);
      } catch {
        return false;
      }
    }
    return false;
  }
  return roots.has(pid);
}

function readTailJsonLines(file: string | undefined, maxBytes = 32768): any[] {
  if (!file || !existsSync(file)) return [];
  let fd: number | undefined;
  try {
    const st = statSync(file);
    if (st.size === 0) return [];
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    fd = openSync(file, "r");
    const buf = Buffer.allocUnsafe(len);
    const read = readSync(fd, buf, 0, len, start);
    let text = buf.subarray(0, read).toString("utf-8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    const out: any[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {}
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

export function isCodexTranscriptBusy(file: string | undefined): boolean {
  const rows = readTailJsonLines(file);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r?.type === "event_msg") {
      const t = r.payload?.type;
      if (t === "task_complete" || t === "turn_aborted") return false;
      if (t === "task_started") return true;
    }
  }
  const lastResp = [...rows].reverse().find(r => r?.type === "response_item");
  if (!lastResp) return false;
  const p = lastResp.payload;
  if (p?.type === "message" && p?.role === "user") return true;
  if (p?.type === "function_call" || p?.type === "custom_tool_call") return true;
  return false;
}

export function isAgyTranscriptBusy(file: string | undefined): boolean {
  const rows = readTailJsonLines(file);
  const last = rows.at(-1);
  if (!last) return false;
  if (
    typeof last.status === "string" &&
    !["DONE", "ERROR", "CANCELLED", "CANCELED"].includes(last.status.toUpperCase())
  ) {
    return true;
  }
  if (last.type === "USER_INPUT") return true;
  if (
    last.type === "PLANNER_RESPONSE" &&
    Array.isArray(last.tool_calls) &&
    last.tool_calls.length > 0
  ) {
    return true;
  }
  if (/TOOL/i.test(String(last.type || ""))) return true;
  return false;
}

export function isGrokTranscriptBusy(file: string | undefined): boolean {
  if (!file || !existsSync(file)) return false;
  const rows = readTailJsonLines(file);
  const last = rows.at(-1);
  if (!last) return false;
  const u = last.params?.update ?? last.update ?? last;
  if (u?.sessionUpdate === "user_message_chunk") return true;
  if (
    (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") &&
    ["in_progress", "pending"].includes(String(u.status || ""))
  ) {
    return true;
  }
  try {
    if (Date.now() - statSync(file).mtimeMs < 1200 && u?.sessionUpdate === "agent_message_chunk") {
      return true;
    }
  } catch {}
  return false;
}

function linuxFlockHolders(lockFile: string, ownPids: Set<number>): number[] {
  if (!existsSync(lockFile)) return [];
  try {
    const inode = String(statSync(lockFile).ino);
    const holders = new Set<number>();
    for (const line of readFileSync("/proc/locks", "utf-8").split("\n")) {
      const cols = line.trim().split(/\s+/);
      if (cols[5]?.split(":").at(-1) !== inode) continue;
      const pid = Number(cols[4]);
      if (pid > 1 && alive(pid) && sameUid(pid) && !ownProcess(pid, ownPids)) {
        holders.add(pid);
      }
    }
    return [...holders];
  } catch {
    return [];
  }
}

function flockHolders(lockFile: string, ownPids: Set<number>): number[] {
  if (!existsSync(lockFile)) return [];
  if (process.platform === "linux") return linuxFlockHolders(lockFile, ownPids);
  try {
    const out = execFileSync("lsof", ["-t", lockFile], {
      timeout: 1000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter(pid => pid > 1 && alive(pid) && sameUid(pid) && !ownProcess(pid, ownPids));
  } catch {
    return [];
  }
}

function isUnixSocketFile(sockPath: string | undefined): sockPath is string {
  if (!sockPath) return false;
  try {
    return statSync(sockPath).isSocket();
  } catch {
    return false;
  }
}

function readCmdlineArgs(pid: number): string[] {
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").filter(Boolean);
    } catch {
      return [];
    }
  }
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      timeout: 800,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? out.split(/\s+/) : [];
  } catch {
    return [];
  }
}

function extractFlagValue(args: string[], flags: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const f of flags) {
      if (a === f && args[i + 1]) return args[i + 1];
      if (a.startsWith(`${f}=`)) return a.slice(f.length + 1);
    }
  }
  return undefined;
}

export function cooperativeLockPaths(lockDir: string, adapter: string, id: string): {
  lockFile: string;
  ownerFile: string;
} {
  const safe = `${adapter}__${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  return {
    lockFile: join(lockDir, `${safe}.lock`),
    ownerFile: join(lockDir, `${safe}.owner.json`),
  };
}

export function inspectCooperativeLock(
  adapter: string,
  id: string,
  cwd: string,
  lockDir: string | undefined,
  ownPids: Set<number>,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): SessionOwnerInspection | null {
  if (!lockDir || (adapter !== "claude" && adapter !== "agy")) return null;
  const { lockFile, ownerFile } = cooperativeLockPaths(lockDir, adapter, id);
  if (!existsSync(lockFile)) return null;

  let holders: number[] = [];
  let externallyLocked = false;
  if (process.platform === "linux") {
    holders = linuxFlockHolders(lockFile, ownPids);
    externallyLocked = holders.length > 0;
  } else {
    try {
      execFileSync(
        "python3",
        [
          "-c",
          "import fcntl,os,sys; fd=os.open(sys.argv[1],os.O_RDWR); fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)",
          lockFile,
        ],
        { timeout: 800, stdio: "ignore" },
      );
    } catch {
      externallyLocked = true;
    }
  }
  if (!externallyLocked) return null;

  let ownerPid: number | undefined;
  let ownerStartTime: string | undefined;
  try {
    const meta = JSON.parse(readFileSync(ownerFile, "utf-8")) as {
      pid?: unknown;
      holder?: unknown;
      startTime?: unknown;
    };
    if (meta.holder === "daemon" && ownProcess(Number(meta.pid), ownPids)) return null;
    const candidatePid = Number(meta.pid);
    if (candidatePid > 1 && alive(candidatePid) && sameUid(candidatePid) && !ownProcess(candidatePid, ownPids)) {
      ownerPid = candidatePid;
      ownerStartTime =
        typeof meta.startTime === "string" && meta.startTime
          ? meta.startTime
          : procStartTime(candidatePid);
    }
  } catch {}
  if (!ownerPid && holders.length === 1) {
    ownerPid = holders[0];
    ownerStartTime = procStartTime(holders[0]);
  }

  let busy = false;
  if (adapter === "claude") {
    const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
    if (ownerPid) {
      try {
        const row = JSON.parse(readFileSync(join(claudeDir, "sessions", `${ownerPid}.json`), "utf-8"));
        busy = row.status === "busy" || row.status === "waiting";
      } catch {}
    }
  } else if (adapter === "agy") {
    busy = isAgyTranscriptBusy(sessionFile("agy", id, cwd, home, env));
  }

  return {
    ownedByExternal: true,
    busy,
    canTakeover: Boolean(ownerPid),
    ownerPid,
    ownerStartTime,
  };
}

/**
 * Acquires a non-blocking OS-level `flock` shared with `html-preview session <claude|agy>`.
 * Returns `null` if an external cooperative terminal currently holds the lock.
 */
export async function acquireCooperativeSessionLock(
  lockDir: string | undefined,
  adapter: string,
  id: string,
): Promise<CooperativeLockHandle | null> {
  if (!lockDir || (adapter !== "claude" && adapter !== "agy") || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) {
    return { release() {} };
  }
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(lockDir, 0o700);
  } catch {}
  const { lockFile, ownerFile } = cooperativeLockPaths(lockDir, adapter, id);
  const metaBase = JSON.stringify({
    holder: "daemon",
    daemonPid: process.pid,
    adapterId: adapter,
    sessionId: id,
    startedAt: new Date().toISOString(),
  });
  const pyScript = [
    "import fcntl, json, os, sys",
    "fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)",
    "try:",
    "    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)",
    "except BlockingIOError:",
    "    sys.stdout.write('BUSY\\n'); sys.stdout.flush(); sys.exit(2)",
    "meta = json.loads(sys.argv[3]); meta['pid'] = os.getpid()",
    "with open(sys.argv[2], 'w', encoding='utf-8') as f: f.write(json.dumps(meta))",
    "try: os.chmod(sys.argv[2], 0o600)",
    "except OSError: pass",
    "sys.stdout.write('LOCKED\\n'); sys.stdout.flush()",
    "try: sys.stdin.read()",
    "finally:",
    "    try: os.unlink(sys.argv[2])",
    "    except OSError: pass",
  ].join("\n");

  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawn("python3", ["-c", pyScript, lockFile, ownerFile, metaBase], {
        stdio: ["pipe", "pipe", "ignore"],
        shell: false,
      });
    } catch {
      resolve({ release() {} });
      return;
    }

    let settled = false;
    let out = "";
    const release = () => {
      try {
        child.stdin?.end();
      } catch {}
      try {
        child.kill("SIGTERM");
      } catch {}
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      release();
      resolve({ release() {} });
    }, 1500);
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf-8");
      if (!settled && out.includes("LOCKED")) {
        settled = true;
        clearTimeout(timer);
        resolve({ pid: child.pid, release });
      } else if (!settled && out.includes("BUSY")) {
        settled = true;
        clearTimeout(timer);
        release();
        resolve(null);
      }
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ release() {} });
    });
    child.once("exit", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 2 ? null : { release() {} });
    });
  });
}

/**
 * Inspects who currently owns a coding-agent session on this machine without leaking any log contents.
 */
export function inspectSessionOwner(
  adapter: string,
  id: string,
  cwd: string,
  ownPids = new Set<number>(),
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  lockDir?: string,
): SessionOwnerInspection {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) return { ownedByExternal: false };

  const coop = inspectCooperativeLock(adapter, id, cwd, lockDir, ownPids, home, env);
  if (coop) return coop;

  if (adapter === "codex") {
    const codexDir = env.CODEX_HOME || join(home, ".codex");
    const envRemote = env.CODEX_REMOTE_UNIX_SOCKET?.replace(/^unix:\/\//, "").trim();
    if (isUnixSocketFile(envRemote)) {
      return {
        ownedByExternal: false,
        sharedEndpoint: { kind: "codex-app-server", socketPath: envRemote },
      };
    }

    const lock = join(codexDir, "thread-writer-locks", `${id}.lock`);
    const holders = flockHolders(lock, ownPids);
    if (holders.length > 0) {
      for (const pid of holders) {
        const args = readCmdlineArgs(pid);
        if (args.includes("app-server")) {
          const listenRaw = extractFlagValue(args, ["--listen"]);
          const listenSock = listenRaw?.startsWith("unix://") ? listenRaw.slice(7) : undefined;
          const defaultSock = join(codexDir, "app-server-control", "app-server-control.sock");
          const sock = isUnixSocketFile(listenSock)
            ? listenSock
            : isUnixSocketFile(defaultSock)
              ? defaultSock
              : undefined;
          if (sock) {
            return {
              ownedByExternal: false,
              sharedEndpoint: { kind: "codex-app-server", socketPath: sock },
            };
          }
          // Shared app-server holds lock without reachable Unix socket -> never SIGINT it!
          return {
            ownedByExternal: true,
            busy: isCodexTranscriptBusy(sessionFile("codex", id, cwd, home, env)),
            canTakeover: false,
          };
        }
      }
      const singlePid = holders.length === 1 ? holders[0] : undefined;
      return {
        ownedByExternal: true,
        busy: isCodexTranscriptBusy(sessionFile("codex", id, cwd, home, env)),
        canTakeover: Boolean(singlePid),
        ownerPid: singlePid,
        ownerStartTime: singlePid ? procStartTime(singlePid) : undefined,
      };
    }

    // Also detect an active `codex --remote unix://<sock>` client referencing this session
    if (process.platform === "linux") {
      const myUid = typeof process.getuid === "function" ? process.getuid() : null;
      try {
        for (const entry of readdirSync("/proc")) {
          if (!/^\d+$/.test(entry)) continue;
          const pid = Number(entry);
          if (ownProcess(pid, ownPids)) continue;
          try {
            if (myUid !== null && statSync(`/proc/${pid}`).uid !== myUid) continue;
          } catch {
            continue;
          }
          const args = readCmdlineArgs(pid);
          if (!args.length || basename(args[0]) !== "codex") continue;
          const remoteRaw = extractFlagValue(args, ["--remote"]);
          const remoteSock = remoteRaw?.startsWith("unix://") ? remoteRaw.slice(7) : undefined;
          if (isUnixSocketFile(remoteSock) && (args.includes(id) || readlinkSafe(`/proc/${pid}/cwd`) === cwd)) {
            return {
              ownedByExternal: false,
              sharedEndpoint: { kind: "codex-app-server", socketPath: remoteSock },
            };
          }
        }
      } catch {}
    }
    return { ownedByExternal: false };
  }

  if (adapter === "claude") {
    const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
    const sessionsDir = join(claudeDir, "sessions");
    if (!existsSync(sessionsDir)) return { ownedByExternal: false };
    try {
      const matches: Array<{ pid: number; status?: string }> = [];
      for (const name of readdirSync(sessionsDir)) {
        if (!name.endsWith(".json")) continue;
        try {
          const row = JSON.parse(readFileSync(join(sessionsDir, name), "utf-8"));
          const pid = Number(row.pid);
          if (row.sessionId === id && alive(pid) && sameUid(pid) && !ownProcess(pid, ownPids)) {
            matches.push({ pid, status: typeof row.status === "string" ? row.status : undefined });
          }
        } catch {}
      }
      if (matches.length === 0) return { ownedByExternal: false };
      const single = matches.length === 1 ? matches[0] : undefined;
      const busy = matches.some(m => m.status === "busy" || m.status === "waiting");
      return {
        ownedByExternal: true,
        busy,
        canTakeover: Boolean(single),
        ownerPid: single?.pid,
        ownerStartTime: single ? procStartTime(single.pid) : undefined,
      };
    } catch {
      return { ownedByExternal: false };
    }
  }

  if (adapter === "grok") {
    const grokDir = env.GROK_HOME || join(home, ".grok");
    const envSock = env.GROK_LEADER_SOCKET?.trim();
    if (isUnixSocketFile(envSock)) {
      return {
        ownedByExternal: false,
        sharedEndpoint: { kind: "grok-leader", socketPath: envSock },
      };
    }

    if (process.platform === "linux") {
      const myUid = typeof process.getuid === "function" ? process.getuid() : null;
      const matchedPids: Array<{ pid: number; isLeader: boolean; args: string[]; multiSession: boolean }> = [];
      try {
        for (const entry of readdirSync("/proc")) {
          if (!/^\d+$/.test(entry)) continue;
          const pid = Number(entry);
          if (ownProcess(pid, ownPids)) continue;
          try {
            if (myUid !== null && statSync(`/proc/${pid}`).uid !== myUid) continue;
          } catch {
            continue;
          }
          const args = readCmdlineArgs(pid);
          if (!args.length || !/\bgrok\b/.test(basename(args[0]))) continue;
          if (args.includes("agent") && args.includes("stdio") && !args.includes("--leader-daemon")) continue;

          const fds = listProcFds(pid);
          const sessionFds = new Set<string>();
          for (const target of fds) {
            const m = target.match(/\/sessions\/[^/]+\/([^/]+)\/(?:events|updates)\.jsonl$/);
            if (m?.[1]) sessionFds.add(m[1]);
          }
          const hasExplicitId = args.includes(id);
          if (!sessionFds.has(id) && !hasExplicitId) continue;
          const isLeader =
            (args.includes("--leader") && !args.includes("--no-leader")) ||
            args.includes("--leader-daemon") ||
            sessionFds.size > 1;
          matchedPids.push({ pid, isLeader, args, multiSession: sessionFds.size > 1 });
        }
      } catch {}

      for (const m of matchedPids) {
        if (m.isLeader) {
          const sockArg = extractFlagValue(m.args, ["--leader-socket"]);
          const defaultSock = join(grokDir, "leader.sock");
          const sock = isUnixSocketFile(sockArg)
            ? sockArg
            : isUnixSocketFile(defaultSock)
              ? defaultSock
              : undefined;
          if (sock) {
            return {
              ownedByExternal: false,
              sharedEndpoint: { kind: "grok-leader", socketPath: sock },
            };
          }
          return {
            ownedByExternal: true,
            busy: isGrokTranscriptBusy(sessionFile("grok", id, cwd, home, env)),
            canTakeover: false,
          };
        }
      }

      if (matchedPids.length > 0) {
        const single = matchedPids.length === 1 && !matchedPids[0].multiSession ? matchedPids[0] : undefined;
        return {
          ownedByExternal: true,
          busy: isGrokTranscriptBusy(sessionFile("grok", id, cwd, home, env)),
          canTakeover: Boolean(single),
          ownerPid: single?.pid,
          ownerStartTime: single ? procStartTime(single.pid) : undefined,
        };
      }
    }

    const defaultLeaderSock = join(grokDir, "leader.sock");
    if (isUnixSocketFile(defaultLeaderSock)) {
      return {
        ownedByExternal: false,
        sharedEndpoint: { kind: "grok-leader", socketPath: defaultLeaderSock },
      };
    }
    return { ownedByExternal: false };
  }

  if (adapter === "agy") {
    if (process.platform === "linux") {
      const myUid = typeof process.getuid === "function" ? process.getuid() : null;
      const matches: Array<{ pid: number; multiSession: boolean; isAcp: boolean }> = [];
      try {
        for (const entry of readdirSync("/proc")) {
          if (!/^\d+$/.test(entry)) continue;
          const pid = Number(entry);
          if (ownProcess(pid, ownPids)) continue;
          try {
            if (myUid !== null && statSync(`/proc/${pid}`).uid !== myUid) continue;
          } catch {
            continue;
          }
          const args = readCmdlineArgs(pid);
          if (!args.length) continue;
          const bin = basename(args[0]);
          const joined = args.join(" ");
          if (bin !== "agy" && bin !== "antigravity" && !joined.includes("antigravity-cli")) continue;

          const fds = listProcFds(pid);
          const dbSessions = new Set<string>();
          let matchesTargetFd = false;
          for (const target of fds) {
            const dbMatch = target.match(/\/conversations\/([A-Za-z0-9_-]+)\.db(?:-wal|-shm)?$/);
            if (dbMatch?.[1]) {
              dbSessions.add(dbMatch[1]);
              if (dbMatch[1] === id) matchesTargetFd = true;
            }
            if (target.includes(`/brain/${id}/`)) matchesTargetFd = true;
          }
          const flagRef = extractFlagValue(args, ["--conversation", "--resume", "--session"]);
          if (!matchesTargetFd && flagRef !== id) continue;

          matches.push({
            pid,
            multiSession: dbSessions.size > 1,
            isAcp: args.includes("acp"),
          });
        }
      } catch {}

      if (matches.length === 0) return { ownedByExternal: false };
      const single =
        matches.length === 1 && !matches[0].multiSession && !matches[0].isAcp
          ? matches[0]
          : undefined;
      return {
        ownedByExternal: true,
        busy: isAgyTranscriptBusy(sessionFile("agy", id, cwd, home, env)),
        canTakeover: Boolean(single),
        ownerPid: single?.pid,
        ownerStartTime: single ? procStartTime(single.pid) : undefined,
      };
    }

    // Non-Linux fallback (e.g., macOS): never guess by cwd alone; keep uncertain cases safely queued.
    try {
      const myUid = typeof process.getuid === "function" ? process.getuid() : null;
      const rows = execFileSync("ps", ["-axo", "uid=,pid=,args="], {
        encoding: "utf-8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      }).split("\n");
      let sawUnverifiedAgy = false;
      const exactPids: number[] = [];
      for (const row of rows) {
        const m = row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        const uid = Number(m[1]);
        const pid = Number(m[2]);
        const argsStr = m[3];
        if ((myUid !== null && uid !== myUid) || ownProcess(pid, ownPids)) continue;
        if (!/(?:^|[/\s])(?:agy|antigravity)(?:\s|$)/.test(argsStr) || /\bacp\b/.test(argsStr)) continue;
        if (argsStr.includes(id)) exactPids.push(pid);
        else sawUnverifiedAgy = true;
      }
      if (exactPids.length === 1) {
        return {
          ownedByExternal: true,
          busy: isAgyTranscriptBusy(sessionFile("agy", id, cwd, home, env)),
          canTakeover: true,
          ownerPid: exactPids[0],
          ownerStartTime: procStartTime(exactPids[0]),
        };
      }
      if (exactPids.length > 1 || sawUnverifiedAgy) {
        return {
          ownedByExternal: true,
          uncertain: true,
          canTakeover: false,
          reason: "检测到未受控终端进程，当前平台无法精确核验会话 FD，已安全排队",
        };
      }
    } catch {}
    return { ownedByExternal: false };
  }

  return { ownedByExternal: false };
}

function readlinkSafe(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

function listProcFds(pid: number): string[] {
  const out: string[] = [];
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      const target = readlinkSafe(`/proc/${pid}/fd/${fd}`);
      if (target) out.push(target);
    }
  } catch {}
  return out;
}

/** No log content leaves the daemon except normalized ACP updates. */
export function terminalOwnsSession(
  adapter: string,
  id: string,
  cwd: string,
  ownPids = new Set<number>(),
  home = homedir(),
): boolean {
  const res = inspectSessionOwner(adapter, id, cwd, ownPids, home);
  return Boolean(res.ownedByExternal || res.uncertain);
}

const textOf = (value: any): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map(c => c.text ?? c.input_text ?? c.output_text ?? "").join("")
      : "";
const message = (role: string, text: string, id?: string): AcpUpdate => ({
  sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
  ...(id ? { messageId: id } : {}),
  content: { type: "text", text },
});
const tool = (id: string, value: any): AcpUpdate => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  title: value.name || value.tool_name || "Tool",
  kind: "other",
  status: "in_progress",
  rawInput: value.arguments ?? value.input ?? value,
});
const output = (id: string, value: any): AcpUpdate => ({
  sessionUpdate: "tool_call_update",
  toolCallId: id,
  status: "completed",
  content: [
    {
      type: "content",
      content: { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
    },
  ],
});

export function transcriptUpdates(adapter: string, row: any): AcpUpdate[] {
  if (!row || typeof row !== "object") return [];
  if (adapter === "grok") {
    const u = row.params?.update ?? row.update ?? (row.sessionUpdate ? row : undefined);
    return u ? [u] : [];
  }
  if (adapter === "codex" && row.type === "response_item") {
    const p = row.payload;
    if (p?.type === "message" && ["user", "assistant"].includes(p.role)) {
      return [message(p.role, textOf(p.content), p.id)];
    }
    if (["function_call", "custom_tool_call"].includes(p?.type)) {
      return [tool(p.call_id, { name: p.name, input: p.arguments ?? p.input })];
    }
    if (["function_call_output", "custom_tool_call_output"].includes(p?.type)) {
      return [output(p.call_id, p.output)];
    }
    if (p?.type === "reasoning") {
      return [
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: textOf(p.summary || p.content) } },
      ];
    }
  }
  if (adapter === "claude" && ["user", "assistant"].includes(row.type)) {
    const parts = row.message?.content;
    if (typeof parts === "string") return [message(row.type, parts, row.uuid)];
    return (Array.isArray(parts) ? parts : []).flatMap((part: any): AcpUpdate[] => {
      if (part.type === "text") return [message(row.type, part.text, row.uuid)];
      if (part.type === "thinking") {
        return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: part.thinking } }];
      }
      if (part.type === "tool_use") return [tool(part.id, part)];
      if (part.type === "tool_result") return [output(part.tool_use_id, part.content)];
      return [{ sessionUpdate: "content", content: part }];
    });
  }
  if (adapter === "agy") {
    const id = String(row.step_index ?? "");
    if (row.type === "USER_INPUT") return [message("user", textOf(row.content), `user-${id}`)];
    if (row.type === "PLANNER_RESPONSE") {
      return [
        ...(row.content ? [message("assistant", textOf(row.content), `agent-${id}`)] : []),
        ...(row.tool_calls || []).map((t: any, i: number) => tool(t.id || `${id}-${i}`, t)),
      ];
    }
    if (/TOOL/.test(row.type || "")) return [output(row.tool_call_id || id, row)];
  }
  return [];
}

/** Incremental UTF-8 tail, including partial lines and truncate/replace recovery. */
export class SessionFileTail {
  private offset = 0;
  private partial = "";
  private decoder = new StringDecoder("utf8");
  private inode?: number;
  private watcher?: FSWatcher;
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor(
    private file: string,
    private onRow: (row: unknown) => void,
    private onReset: () => void,
    private pollMs = 150,
  ) {}

  read(): void {
    let fd: number | undefined;
    try {
      const stat = statSync(this.file);
      if (this.inode !== undefined && (stat.ino !== this.inode || stat.size < this.offset)) {
        this.offset = 0;
        this.partial = "";
        this.decoder = new StringDecoder("utf8");
        this.onReset();
      }
      this.inode = stat.ino;
      if (this.offset >= stat.size) return;
      fd = openSync(this.file, "r");
      const buffer = Buffer.allocUnsafe(65536);
      while (this.offset < stat.size) {
        const n = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - this.offset), this.offset);
        if (!n) break;
        this.offset += n;
        const lines = (this.partial + this.decoder.write(buffer.subarray(0, n))).split("\n");
        this.partial = lines.pop() || "";
        for (const line of lines) {
          try {
            this.onRow(JSON.parse(line));
          } catch {}
        }
      }
    } catch {} finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  start(): void {
    this.read();
    try {
      const targetName = basename(this.file);
      this.watcher = watch(dirname(this.file), { persistent: false }, (_event, filename) => {
        if (!filename || filename === targetName) this.read();
      });
      this.watcher.on("error", () => {});
    } catch {}
    this.pollTimer = setInterval(() => this.read(), this.pollMs);
    this.pollTimer.unref();
  }

  close(): void {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {}
      this.watcher = undefined;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}
