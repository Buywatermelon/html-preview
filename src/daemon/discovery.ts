import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { HostIdentity } from "./host-identity";
import { encodeOpaqueBinding, type OpaqueAgentEndpoint } from "./opaque-binding";

export interface PrepareUploadRequest {
  serverUrl?: string;
  callerPid?: number;
  callerPpid?: number;
  cwd?: string;
  sourceFile?: string;
  envHints?: Record<string, string>;
}

export interface PrepareUploadResponse {
  hostId: string;
  hostName: string;
  binding: string;
}

export interface AncestorProcessInfo {
  pid: number;
  ppid: number;
  comm: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

type PsRunner = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

const RELEVANT_ENV_KEYS = new Set([
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "CLAUDECODE",
  "ANTIGRAVITY_CONVERSATION_ID",
  "AGY_SESSION_ID",
  "AGY_CONVERSATION_ID",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "GROK_SESSION_ID",
]);

const UUID_LIKE_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function defaultPsRunner(timeoutMs = 80): PsRunner {
  return (cmd, args) =>
    new Promise(resolve => {
      execFile(
        cmd,
        args,
        {
          shell: false,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const outStr = typeof stdout === "string" ? stdout : String(stdout ?? "");
          const errStr = typeof stderr === "string" ? stderr : String(stderr ?? "");
          if (!error) {
            resolve({ code: 0, stdout: outStr, stderr: errStr });
            return;
          }
          const rawCode = (error as NodeJS.ErrnoException & { code?: unknown }).code;
          resolve({
            code: typeof rawCode === "number" ? rawCode : 1,
            stdout: outStr,
            stderr: errStr || error.message,
          });
        },
      );
    });
}

function readLinuxProcNode(pid: number, myUid: number | null): AncestorProcessInfo | null {
  const procDir = `/proc/${pid}`;
  try {
    const st = statSync(procDir);
    if (myUid !== null && st.uid !== myUid) {
      return null;
    }
    const statRaw = readFileSync(`${procDir}/stat`, "utf-8");
    const closeParen = statRaw.lastIndexOf(")");
    const openParen = statRaw.indexOf("(");
    if (openParen < 0 || closeParen < 0) return null;
    const comm = statRaw.slice(openParen + 1, closeParen);
    const restFields = statRaw.slice(closeParen + 2).trim().split(/\s+/);
    const ppid = Number(restFields[1] || "0");

    let args: string[] = [];
    try {
      const cmdRaw = readFileSync(`${procDir}/cmdline`, "utf-8");
      args = cmdRaw.split("\0").filter(Boolean);
    } catch {
      args = [comm];
    }

    const env: Record<string, string> = {};
    try {
      const envRaw = readFileSync(`${procDir}/environ`, "utf-8");
      for (const entry of envRaw.split("\0")) {
        const eq = entry.indexOf("=");
        if (eq <= 0) continue;
        const key = entry.slice(0, eq);
        if (!RELEVANT_ENV_KEYS.has(key)) continue;
        const val = entry.slice(eq + 1).trim();
        if (val) env[key] = val;
      }
    } catch {
      // /proc/<pid>/environ may be unreadable on hardened kernels
    }

    let cwd: string | undefined;
    try {
      cwd = readlinkSync(`${procDir}/cwd`);
    } catch {
      // Ignore
    }

    return { pid, ppid: Number.isFinite(ppid) ? ppid : 0, comm, args, env, cwd };
  } catch {
    return null;
  }
}

async function walkProcessAncestorsDefault(
  startPid?: number,
  startPpid?: number,
  runner: PsRunner = defaultPsRunner(80),
): Promise<AncestorProcessInfo[]> {
  const seedPid = startPid && startPid > 1 ? startPid : startPpid && startPpid > 1 ? startPpid : 0;
  if (!seedPid) return [];

  const myUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (existsSync("/proc/self/stat")) {
    const chain: AncestorProcessInfo[] = [];
    const visited = new Set<number>();
    let cur = seedPid;
    while (cur > 1 && chain.length < 18 && !visited.has(cur)) {
      visited.add(cur);
      const info = readLinuxProcNode(cur, myUid);
      if (!info) break;
      chain.push(info);
      cur = info.ppid;
    }
    if (chain.length > 0) return chain;
  }

  // POSIX fallback (macOS / BSD)
  const psRes = await runner("ps", ["-axo", "pid=,ppid=,comm=,args="]).catch(() => ({
    code: 1,
    stdout: "",
    stderr: "",
  }));
  if (psRes.code !== 0 || !psRes.stdout.trim()) return [];

  const table = new Map<number, AncestorProcessInfo>();
  for (const line of psRes.stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const comm = basename(m[3]);
    const argsStr = m[4] || comm;
    table.set(pid, {
      pid,
      ppid,
      comm,
      args: argsStr.split(/\s+/).filter(Boolean),
      env: {},
    });
  }

  const chain: AncestorProcessInfo[] = [];
  const visited = new Set<number>();
  let cur = seedPid;
  while (cur > 1 && chain.length < 18 && !visited.has(cur)) {
    visited.add(cur);
    const node = table.get(cur);
    if (!node) break;
    chain.push(node);
    cur = node.ppid;
  }
  return chain;
}

function extractFlagArg(args: string[], flagNames: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    for (const flag of flagNames) {
      if (arg === flag && typeof args[i + 1] === "string" && args[i + 1].trim()) {
        return args[i + 1].trim();
      }
      if (arg.startsWith(`${flag}=`)) {
        const val = arg.slice(flag.length + 1).trim();
        if (val) return val;
      }
    }
  }
  return undefined;
}

function readFirstLineHead(filePath: string, maxBytes = 4096): string {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const read = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, read).toString("utf-8").split(/\r?\n/)[0]?.trim() || "";
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore
      }
    }
  }
}

function scanRecentClaudeSessionId(
  cwd: string | undefined,
  homeDir: string,
  hasClaudeSignal: boolean,
): string | undefined {
  if (!cwd) return undefined;
  const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
  const projDir = join(homeDir, ".claude", "projects", slug);
  if (!existsSync(projDir)) return undefined;

  try {
    const now = Date.now();
    const maxAgeMs = hasClaudeSignal ? 7 * 24 * 3600_000 : 2 * 3600_000;
    let bestId: string | undefined;
    let bestMtime = 0;

    for (const entry of readdirSync(projDir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const stem = entry.slice(0, -6);
      if (!UUID_LIKE_RE.test(stem)) continue;
      const fullPath = join(projDir, entry);
      const st = statSync(fullPath);
      if (now - st.mtimeMs > maxAgeMs) continue;
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        bestId = stem;
      }
    }
    return bestId;
  } catch {
    return undefined;
  }
}

function scanRecentCodexSessionId(
  cwd: string | undefined,
  homeDir: string,
  hasCodexSignal: boolean,
): string | undefined {
  if (!cwd) return undefined;
  const rootDir = join(homeDir, ".codex", "sessions");
  if (!existsSync(rootDir)) return undefined;

  const maxAgeMs = hasCodexSignal ? 7 * 24 * 3600_000 : 2 * 3600_000;
  const now = Date.now();
  const candidates: Array<{ filePath: string; mtimeMs: number }> = [];

  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full, depth + 1);
        } else if (name.endsWith(".jsonl") && now - st.mtimeMs <= maxAgeMs) {
          candidates.push({ filePath: full, mtimeMs: st.mtimeMs });
        }
      } catch {
        // Ignore
      }
    }
  };
  walk(rootDir, 0);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const item of candidates.slice(0, 25)) {
    const firstLine = readFirstLineHead(item.filePath);
    if (!firstLine.startsWith("{")) continue;
    try {
      const obj = JSON.parse(firstLine) as {
        payload?: { id?: unknown; session_id?: unknown; cwd?: unknown };
      };
      if (obj.payload?.cwd !== cwd) continue;
      const id = obj.payload?.id ?? obj.payload?.session_id;
      if (typeof id === "string" && id.trim()) {
        return id.trim();
      }
    } catch {
      // Ignore
    }
  }
  return undefined;
}

function scanAgyAncestorOpenFdSessionId(ancestors: AncestorProcessInfo[]): string | undefined {
  if (!existsSync("/proc/self/stat")) return undefined;
  for (const anc of ancestors) {
    const binName = basename(anc.args[0] || anc.comm).toLowerCase();
    const joinedArgs = anc.args.join(" ").toLowerCase();
    if (binName !== "agy" && binName !== "antigravity" && !joinedArgs.includes("antigravity-cli")) {
      continue;
    }
    try {
      const ids = new Set<string>();
      for (const fd of readdirSync(`/proc/${anc.pid}/fd`)) {
        try {
          const target = readlinkSync(`/proc/${anc.pid}/fd/${fd}`);
          const m = target.match(/\/conversations\/([0-9a-fA-F-]{36})\.db(?:-wal|-shm)?$/);
          if (m?.[1]) ids.add(m[1]);
        } catch {}
      }
      if (ids.size === 1) return [...ids][0];
    } catch {}
  }
  return undefined;
}

function scanRecentAgySessionId(homeDir: string, ancestors: AncestorProcessInfo[] = []): string | undefined {
  const fromFd = scanAgyAncestorOpenFdSessionId(ancestors);
  if (fromFd) return fromFd;
  const brainDir = join(homeDir, ".gemini", "antigravity-cli", "brain");
  if (!existsSync(brainDir)) return undefined;
  try {
    let bestId: string | undefined;
    let bestMtime = 0;
    const now = Date.now();
    for (const name of readdirSync(brainDir)) {
      if (!UUID_LIKE_RE.test(name)) continue;
      const tf = join(brainDir, name, ".system_generated", "logs", "transcript.jsonl");
      if (!existsSync(tf)) continue;
      const st = statSync(tf);
      if (now - st.mtimeMs > 7 * 24 * 3600_000) continue;
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        bestId = name;
      }
    }
    return bestId;
  } catch {
    return undefined;
  }
}

export class SessionDiscovery {
  private readonly runner: PsRunner;
  private readonly homeDir: string;
  private readonly walkAncestors: (
    callerPid?: number,
    callerPpid?: number,
  ) => Promise<AncestorProcessInfo[]>;

  constructor(opts?: {
    runner?: PsRunner;
    homeDir?: string;
    walkAncestors?: (callerPid?: number, callerPpid?: number) => Promise<AncestorProcessInfo[]>;
  }) {
    this.runner = opts?.runner ?? defaultPsRunner(80);
    this.homeDir = opts?.homeDir ?? homedir();
    this.walkAncestors =
      opts?.walkAncestors ??
      ((pid, ppid) => walkProcessAncestorsDefault(pid, ppid, this.runner));
  }

  async prepareUpload(
    identity: HostIdentity,
    req: PrepareUploadRequest,
  ): Promise<PrepareUploadResponse> {
    const ancestors = await this.walkAncestors(req.callerPid, req.callerPpid).catch(() => []);

    const mergedEnv: Record<string, string> = {};
    for (let i = ancestors.length - 1; i >= 0; i--) {
      Object.assign(mergedEnv, ancestors[i].env);
    }
    if (req.envHints) {
      for (const [k, v] of Object.entries(req.envHints)) {
        if (typeof v === "string" && v.trim()) {
          mergedEnv[k] = v.trim();
        }
      }
    }

    const effectiveCwd =
      (req.cwd && req.cwd.trim()) ||
      ancestors.find(a => a.cwd)?.cwd ||
      undefined;
    const effectiveSourceFile =
      req.sourceFile && req.sourceFile.trim() ? req.sourceFile.trim() : undefined;

    const agent = this.detectCodingAgent(mergedEnv, ancestors, effectiveCwd);
    const binding = encodeOpaqueBinding({
      agent,
      cwd: effectiveCwd ?? null,
      sourceFile: effectiveSourceFile ?? null,
    });

    return {
      hostId: identity.hostId,
      hostName: identity.hostName,
      binding,
    };
  }

  private detectCodingAgent(
    env: Record<string, string>,
    ancestors: AncestorProcessInfo[],
    cwd?: string,
  ): OpaqueAgentEndpoint | null {
    // 1. Explicit environment session IDs
    const claudeEnvRef = env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID;
    if (claudeEnvRef) {
      return { adapter: "claude", ref: claudeEnvRef };
    }
    const agyEnvRef =
      env.ANTIGRAVITY_CONVERSATION_ID || env.AGY_SESSION_ID || env.AGY_CONVERSATION_ID;
    if (agyEnvRef) {
      return { adapter: "agy", ref: agyEnvRef };
    }
    const codexEnvRef = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
    if (codexEnvRef) {
      return { adapter: "codex", ref: codexEnvRef };
    }
    if (env.GROK_SESSION_ID) {
      return { adapter: "grok", ref: env.GROK_SESSION_ID };
    }

    // 2. Ancestor process tree inspection (argv + binary name)
    let hasClaudeAncestor = Boolean(env.CLAUDECODE);
    let hasCodexAncestor = false;
    let hasAgyAncestor = false;

    for (const anc of ancestors) {
      const binName = basename(anc.args[0] || anc.comm).toLowerCase();
      const joinedArgs = anc.args.join(" ").toLowerCase();

      if (binName === "claude" || joinedArgs.includes("@anthropic-ai/claude-code")) {
        hasClaudeAncestor = true;
        const resumed = extractFlagArg(anc.args, ["--resume", "-r", "--session-id"]);
        if (resumed) {
          return { adapter: "claude", ref: resumed };
        }
      }
      if (
        binName === "agy" ||
        binName === "antigravity" ||
        joinedArgs.includes("antigravity-cli")
      ) {
        hasAgyAncestor = true;
        const resumed = extractFlagArg(anc.args, ["--resume", "--conversation", "--session"]);
        if (resumed) {
          return { adapter: "agy", ref: resumed };
        }
      }
      if (binName === "codex" || joinedArgs.includes("@openai/codex")) {
        hasCodexAncestor = true;
        const resumeIdx = anc.args.indexOf("resume");
        if (resumeIdx >= 0 && typeof anc.args[resumeIdx + 1] === "string") {
          return { adapter: "codex", ref: anc.args[resumeIdx + 1] };
        }
      }
    }

    // 3. On-disk session lookup prioritizing ancestor signal
    if (hasCodexAncestor) {
      const codexId = scanRecentCodexSessionId(cwd, this.homeDir, true);
      if (codexId) return { adapter: "codex", ref: codexId };
    }
    if (hasAgyAncestor) {
      const agyId = scanRecentAgySessionId(this.homeDir, ancestors);
      if (agyId) return { adapter: "agy", ref: agyId };
    }
    if (hasClaudeAncestor) {
      const claudeId = scanRecentClaudeSessionId(cwd, this.homeDir, true);
      if (claudeId) return { adapter: "claude", ref: claudeId };
    }

    const claudeDiskId = scanRecentClaudeSessionId(cwd, this.homeDir, false);
    if (claudeDiskId) {
      return { adapter: "claude", ref: claudeDiskId };
    }
    const codexDiskId = scanRecentCodexSessionId(cwd, this.homeDir, false);
    if (codexDiskId) {
      return { adapter: "codex", ref: codexDiskId };
    }

    return null;
  }
}
