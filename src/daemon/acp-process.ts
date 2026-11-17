import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { client, methods, ndJsonStream, type RequestPermissionRequest, type RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { AcpUpdate } from "../acp-types";
import type { SharedExecutorEndpoint } from "./session-files";

export interface AcpProcess {
  pid?: number;
  capabilities: { loadSession?: boolean; sessionCapabilities?: { resume?: unknown; close?: unknown } };
  request(method: string, params: Record<string, unknown>): Promise<Record<string, any>>;
  notify(method: string, params: Record<string, unknown>): Promise<void>;
  close(): void;
}
export interface AcpLaunchOptions {
  adapterId: string;
  cwd: string;
  readOnly: boolean;
  env?: NodeJS.ProcessEnv;
  sharedEndpoint?: SharedExecutorEndpoint;
  bridgeDir?: string;
  onUpdate(update: AcpUpdate): void;
  onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  onExit?(): void;
}
const packages = {
  codex: ["@agentclientprotocol/codex-acp", "2.6.0", "codex-acp"],
  claude: ["@agentclientprotocol/claude-agent-acp", "0.107.0", "claude-agent-acp"],
} as const;

export function acpCommand(
  adapterId: string,
  readOnly: boolean,
  env = process.env,
  sharedEndpoint?: SharedExecutorEndpoint,
): { file: string; args: string[] } {
  if (adapterId === "agy") {
    return {
      file: env.AGY_BIN || "agy",
      args: readOnly ? ["acp", "--agent", "html-preview-readonly"] : ["acp"],
    };
  }
  if (adapterId === "grok") {
    const args =
      !readOnly && sharedEndpoint?.kind === "grok-leader"
        ? ["agent", "--leader", "stdio", "--leader-socket", sharedEndpoint.socketPath]
        : ["agent", "stdio"];
    return { file: env.GROK_BIN || "grok", args };
  }
  if (!(adapterId in packages)) throw new Error(`Unknown ACP adapter: ${adapterId}`);
  const [pkg, version, bin] = packages[adapterId as keyof typeof packages];
  const override = env[adapterId === "codex" ? "CODEX_ACP_BIN" : "CLAUDE_ACP_BIN"];
  if (override) return { file: override, args: [] };
  try {
    const req = createRequire(import.meta.url);
    const extraPaths = [env.HTML_PREVIEW_NODE_MODULES, process.cwd()].filter((p): p is string => Boolean(p));
    const resolved = extraPaths.length > 0
      ? req.resolve(`${pkg}/package.json`, { paths: [dirname(fileURLToPath(import.meta.url)), ...extraPaths] })
      : req.resolve(`${pkg}/package.json`);
    const root = dirname(resolved);
    return { file: process.execPath, args: [join(root, "dist", "index.js")] };
  } catch {
    // The standalone daemon has no node_modules. npm caches these pinned official adapters.
    return { file: "npx", args: ["--yes", `--package=${pkg}@${version}`, bin] };
  }
}

function ensureCodexWsBridgeLauncher(bridgeDir?: string): string {
  const dir = bridgeDir || join(tmpdir(), `hp-codex-bridge-${typeof process.getuid === "function" ? process.getuid() : "u"}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  const selfPath = (() => {
    try {
      return fileURLToPath(import.meta.url);
    } catch {
      return "";
    }
  })();
  const distDaemon = resolve("dist/daemon.mjs");
  const scriptPath = join(dir, "codex-ws-bridge.sh");

  if (selfPath.endsWith("daemon.mjs") && existsSync(selfPath)) {
    writeFileSync(
      scriptPath,
      `#!/bin/sh\nexec "${process.execPath}" "${selfPath}" ws-stdio-bridge "$@"\n`,
      { mode: 0o700 },
    );
  } else if (existsSync(distDaemon)) {
    writeFileSync(
      scriptPath,
      `#!/bin/sh\nexec "${process.execPath}" "${distDaemon}" ws-stdio-bridge "$@"\n`,
      { mode: 0o700 },
    );
  } else {
    const wsPath = createRequire(import.meta.url).resolve("ws");
    const helperCjs = join(dir, "codex-ws-bridge.cjs");
    writeFileSync(
      helperCjs,
      [
        `const WebSocket = require(${JSON.stringify(wsPath)});`,
        `const readline = require("node:readline");`,
        `const sock = process.env.HTML_PREVIEW_CODEX_UNIX_SOCKET;`,
        `if (!sock) process.exit(1);`,
        `const ws = new WebSocket("ws+unix://" + sock + ":/");`,
        `const pending = [];`,
        `readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", l => {`,
        `  if (ws.readyState === 1) ws.send(l); else pending.push(l);`,
        `}).on("close", () => ws.close());`,
        `ws.on("open", () => { for (const l of pending.splice(0)) ws.send(l); });`,
        `ws.on("message", d => { const t = d.toString("utf-8"); process.stdout.write(t.endsWith("\\n") ? t : t + "\\n"); });`,
        `ws.on("close", () => process.exit(0));`,
        `ws.on("error", () => process.exit(1));`,
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
    writeFileSync(
      scriptPath,
      `#!/bin/sh\nexec "${process.execPath}" "${helperCjs}" "$@"\n`,
      { mode: 0o700 },
    );
  }
  try {
    chmodSync(scriptPath, 0o700);
  } catch {}
  return scriptPath;
}

export async function startAcpProcess(opts: AcpLaunchOptions): Promise<AcpProcess> {
  const command = acpCommand(opts.adapterId, opts.readOnly, opts.env, opts.sharedEndpoint);
  const baseEnv = opts.env ?? process.env;
  let codexPath = baseEnv.CODEX_PATH || process.env.CODEX_PATH || "codex";
  const extraEnv: Record<string, string> = {};
  if (!opts.readOnly && opts.adapterId === "codex" && opts.sharedEndpoint?.kind === "codex-app-server") {
    codexPath = ensureCodexWsBridgeLauncher(opts.bridgeDir);
    extraEnv.HTML_PREVIEW_CODEX_UNIX_SOCKET = opts.sharedEndpoint.socketPath;
  }
  if (!opts.readOnly && opts.adapterId === "grok" && opts.sharedEndpoint?.kind === "grok-leader") {
    extraEnv.HTML_PREVIEW_GROK_LEADER_SOCKET = opts.sharedEndpoint.socketPath;
  }
  const child = spawn(command.file, command.args, {
    cwd: opts.cwd,
    env: { ...baseEnv, CODEX_PATH: codexPath, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    shell: false,
  });
  // stderr may contain private model diagnostics; never forward it into server logs.
  child.stderr.resume();
  const conn = client()
    .onNotification(methods.client.session.update, ({ params }) => opts.onUpdate(params.update as AcpUpdate))
    .onRequest(methods.client.session.requestPermission, ({ params }) => opts.onPermission(params))
    .connect(ndJsonStream(Writable.toWeb(child.stdin) as Parameters<typeof ndJsonStream>[0], Readable.toWeb(child.stdout) as unknown as Parameters<typeof ndJsonStream>[1]));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    conn.close();
    terminate(child, "SIGTERM");
    const timer = setTimeout(() => terminate(child, "SIGKILL"), 1500);
    timer.unref();
    child.once("exit", () => clearTimeout(timer));
  };
  child.once("error", () => conn.close(new Error(`Cannot start ${opts.adapterId} ACP adapter`)));
  child.once("exit", () => { conn.close(); if (!closed) opts.onExit?.(); });
  const request = async (method: string, params: Record<string, unknown>): Promise<Record<string, any>> => {
    const call = conn.agent.request(method, params) as Promise<Record<string, any>>;
    if (method === "session/prompt") return call;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([call, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { close(); reject(new Error(`ACP ${method} timed out`)); }, 30_000);
        timer.unref();
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    const initialized = await request("initialize", {
      protocolVersion: 1, clientInfo: { name: "html-preview", version: "1.0.0" }, clientCapabilities: {},
    });
    if (initialized.protocolVersion !== 1) throw new Error("Agent did not negotiate ACP v1");
    return { pid: child.pid, capabilities: initialized.agentCapabilities ?? {}, request,
      notify: (method, params) => conn.agent.notify(method, params), close };
  } catch (error) { close(); throw error; }
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* Already exited. */ }
}
