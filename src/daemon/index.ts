import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { DaemonAlreadyRunningError, HostDaemon } from "./server";
import type { ServerCredential } from "./host-identity";

export * from "./host-identity";
export * from "./opaque-binding";
export * from "./discovery";
export * from "./registry";
export * from "./acp-process";
export * from "./acp-sessions";
export * from "./session-files";
export * from "./transport";
export * from "./server";
export * from "./adapters/acp-agent";

function parseServeArgs(argv: string[]): {
  command: string;
  configDir?: string;
  stateDir?: string;
  socketPath?: string;
  logFile?: string;
  hostName?: string;
  serverUrl?: string;
  token?: string;
  ifNotRunning: boolean;
  logToStderr: boolean;
} {
  let command = "serve";
  let configDir: string | undefined;
  let stateDir: string | undefined;
  let socketPath: string | undefined;
  let logFile: string | undefined;
  let hostName: string | undefined;
  let serverUrl: string | undefined;
  let token: string | undefined;
  let ifNotRunning = false;
  let logToStderr = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (i === 0 && !arg.startsWith("-")) {
      command = arg;
      continue;
    }
    if (arg === "--config-dir") {
      configDir = argv[++i];
    } else if (arg === "--state-dir") {
      stateDir = argv[++i];
    } else if (arg === "--socket") {
      socketPath = argv[++i];
    } else if (arg === "--log-file") {
      logFile = argv[++i];
    } else if (arg === "--name") {
      hostName = argv[++i];
    } else if (arg === "--url") {
      serverUrl = argv[++i];
    } else if (arg === "--token") {
      token = argv[++i];
    } else if (arg === "--if-not-running") {
      ifNotRunning = true;
    } else if (arg === "--stderr") {
      logToStderr = true;
    } else if (arg === "-h" || arg === "--help") {
      command = "help";
    }
  }

  return {
    command,
    configDir,
    stateDir,
    socketPath,
    logFile,
    hostName,
    serverUrl,
    token,
    ifNotRunning,
    logToStderr,
  };
}

export async function runWsStdioBridge(sockPath?: string): Promise<number> {
  const sock = (sockPath || process.env.HTML_PREVIEW_CODEX_UNIX_SOCKET || "").trim();
  if (!sock) {
    process.stderr.write("Missing HTML_PREVIEW_CODEX_UNIX_SOCKET\n");
    return 1;
  }
  return new Promise<number>(resolve => {
    const ws = new WebSocket(`ws+unix://${sock}:/`);
    const pending: string[] = [];
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", line => {
      if (ws.readyState === WebSocket.OPEN) ws.send(line);
      else pending.push(line);
    });
    rl.on("close", () => {
      try {
        ws.close();
      } catch {}
    });
    ws.on("open", () => {
      for (const line of pending.splice(0)) ws.send(line);
    });
    ws.on("message", data => {
      const text = typeof data === "string" ? data : data.toString("utf-8");
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    });
    ws.on("close", () => finish(0));
    ws.on("error", () => finish(1));
  });
}

export async function runDaemonCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv[0] === "ws-stdio-bridge") {
    return runWsStdioBridge();
  }
  const parsed = parseServeArgs(argv);
  if (parsed.command === "help") {
    process.stdout.write(
      [
        "Usage: html-preview-daemon serve [options]",
        "",
        "Options:",
        "  --config-dir <dir>     Override config directory (host.json, credentials.json)",
        "  --state-dir <dir>      Override state directory (daemon.sock, envelopes, logs)",
        "  --socket <path>        Override Unix domain socket path",
        "  --log-file <path>      Override rotating log file path",
        "  --name <hostName>      Set or override local machine display name",
        "  --url <serverUrl>      Explicit server URL override",
        "  --token <token>        Explicit Bearer token override",
        "  --if-not-running       Exit 0 quietly if daemon is already up",
        "  --stderr               Mirror logs to stderr",
        "",
      ].join("\n"),
    );
    return 0;
  }

  if (parsed.command !== "serve") {
    process.stderr.write(`Unknown daemon command: ${parsed.command}\n`);
    return 2;
  }

  const explicitCredentials: ServerCredential[] | undefined =
    parsed.serverUrl && parsed.token
      ? [{ serverUrl: parsed.serverUrl, token: parsed.token }]
      : undefined;

  let shuttingDown = false;
  const daemon = new HostDaemon({
    paths: {
      ...(parsed.configDir ? { configDir: parsed.configDir } : {}),
      ...(parsed.stateDir ? { stateDir: parsed.stateDir } : {}),
      ...(parsed.socketPath ? { socketPath: parsed.socketPath } : {}),
      ...(parsed.logFile ? { logFile: parsed.logFile } : {}),
    },
    preferredHostName: parsed.hostName,
    explicitCredentials,
    logToStderr: parsed.logToStderr,
    onShutdownRequested: () => {
      process.exit(0);
    },
  });

  const handleSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void daemon.stop(15_000).finally(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
    await daemon.start();
  } catch (err) {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    if (err instanceof DaemonAlreadyRunningError && parsed.ifNotRunning) {
      return 0;
    }
    process.stderr.write(
      `Failed to start html-preview daemon: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  // Keep event loop alive until shutdown signal or `/v1/shutdown`
  await new Promise<void>(() => {});
  return 0;
}

const isDirectEntry = (() => {
  if (typeof process === "undefined" || !Array.isArray(process.argv) || !process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
})();

if (isDirectEntry) {
  void runDaemonCli().then(code => {
    process.exit(code);
  });
}
