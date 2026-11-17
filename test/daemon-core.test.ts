import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  AgyAdapter,
  ClaudeCodeAdapter,
  DaemonAlreadyRunningError,
  GrokAdapter,
  HostDaemon,
  SessionDeferredError,
  SessionDiscovery,
  createDefaultRegistry,
  decodeOpaqueBinding,
  encodeOpaqueBinding,
  ensureHostIdentity,
  probeUnixSocketHealth,
} from "../src/daemon/index";
import { startNodePreviewServer, type RunningNodePreviewServer } from "../src/node-server";
import type { ObjectStore } from "../src/storage";

function createMemoryObjectStore(): ObjectStore {
  const objects = new Map<string, { body: Uint8Array; type: string }>();
  return {
    async put(key, body, type) {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      objects.set(key, { body: bytes, type });
    },
    async get(key) {
      const item = objects.get(key);
      if (!item) return null;
      return new Response(item.body, {
        headers: {
          "Content-Type": item.type,
          "Content-Length": String(item.body.byteLength),
        },
      });
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

async function bootTestNodeServer(rootDir: string): Promise<{
  server: RunningNodePreviewServer;
  baseUrl: string;
  token: string;
}> {
  const server = await startNodePreviewServer({
    ALLOW_DEV_LOGIN: "1",
    ADMIN_GITHUB_LOGIN: "alice",
    port: 0,
    host: "127.0.0.1",
    databasePath: join(rootDir, "node-preview.sqlite"),
    store: createMemoryObjectStore(),
  });
  const loginRes = await fetch(`${server.url}/auth/dev-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      login: "alice",
      issueDeviceToken: true,
      deviceName: "Daemon Core Test",
    }),
  });
  const loginJson = (await loginRes.json()) as { deviceToken: string };
  return { server, baseUrl: server.url, token: loginJson.deviceToken };
}

function unixSocketRequestJson<T>(
  socketPath: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const rawBody = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest(
      {
        socketPath,
        path,
        method,
        headers:
          method === "POST"
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(rawBody),
              }
            : {},
      },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
            resolvePromise({ status: res.statusCode ?? 0, data: parsed });
          } catch (err) {
            rejectPromise(err);
          }
        });
      },
    );
    req.on("error", rejectPromise);
    if (method === "POST") {
      req.write(rawBody);
    }
    req.end();
  });
}

function unixSocketPostJson<T>(
  socketPath: string,
  path: string,
  body: unknown,
): Promise<{ status: number; data: T }> {
  return unixSocketRequestJson<T>(socketPath, "POST", path, body);
}

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 5_000,
  stepMs = 30,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, stepMs));
  }
  throw new Error(`Condition did not become true within ${timeoutMs}ms`);
}

describe("HostDaemon, CodingAgent SessionDiscovery, Direct Resume, Lease Renew & Standalone Bundle", () => {
  const tempDirs: string[] = [];
  const servers: RunningNodePreviewServer[] = [];
  const daemons: HostDaemon[] = [];

  function makeTempDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(d);
    return d;
  }

  afterEach(async () => {
    while (daemons.length > 0) {
      const d = daemons.pop()!;
      await d.stop(2_000).catch(() => {});
    }
    while (servers.length > 0) {
      const s = servers.pop()!;
      await s.close().catch(() => {});
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists 0600 host.json across restarts and enforces check-then-start on 0600 daemon.sock", async () => {
    const root = makeTempDir("hp-daemon-id-");
    const configDir = join(root, "config");
    const stateDir = join(root, "state");

    const id1 = ensureHostIdentity(configDir, "MacBook Pro");
    expect(id1.hostId).toMatch(/^hst_[0-9A-Z]{20}$/);
    expect(id1.hostName).toBe("MacBook Pro");
    expect(statSync(join(configDir, "host.json")).mode & 0o777).toBe(0o600);

    // Subsequent calls keep exact same hostId
    const id2 = ensureHostIdentity(configDir);
    expect(id2.hostId).toBe(id1.hostId);
    expect(id2.hostName).toBe("MacBook Pro");

    const daemon = new HostDaemon({
      paths: { configDir, stateDir },
      connectWebSocket: false,
    });
    daemons.push(daemon);
    await daemon.start();

    expect(statSync(daemon.paths.socketPath).mode & 0o777).toBe(0o600);
    const health = await probeUnixSocketHealth(daemon.paths.socketPath);
    expect(health?.ok).toBe(true);
    expect(health?.hostId).toBe(id1.hostId);
    expect(health?.hostName).toBe("MacBook Pro");

    // Second instance on same socket refuses to clobber live daemon
    const duplicate = new HostDaemon({
      paths: { configDir, stateDir },
      connectWebSocket: false,
    });
    await expect(duplicate.start()).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
  });

  it("discovers coding agent sessions via ancestor tree + on-disk logs (/v1/prepare-upload) and lists sessions via GET /v1/sessions", async () => {
    const root = makeTempDir("hp-discovery-");
    const fakeHome = join(root, "home");
    const projectCwd = "/Users/apple/code/arch-report";

    // 1. Seed Claude Code session log
    const claudeSlug = projectCwd.replace(/[^A-Za-z0-9]/g, "-");
    const claudeProjDir = join(fakeHome, ".claude", "projects", claudeSlug);
    mkdirSync(claudeProjDir, { recursive: true });
    const claudeUuid = "6f8d2b10-4c91-4a33-9f88-123456789abc";
    const claudeJsonl = join(claudeProjDir, `${claudeUuid}.jsonl`);
    writeFileSync(
      claudeJsonl,
      `${JSON.stringify({ type: "turn", cwd: projectCwd })}\n`,
      "utf-8",
    );

    // 2. Seed Codex CLI session log
    const codexDir = join(fakeHome, ".codex", "sessions", "2026", "11", "14");
    mkdirSync(codexDir, { recursive: true });
    const codexUuid = "019da8fc-44bb-7ab3-a2c3-d93b5a06db1d";
    const codexJsonl = join(codexDir, `rollout-2026-11-14T12-00-00-${codexUuid}.jsonl`);
    writeFileSync(
      codexJsonl,
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: codexUuid, cwd: projectCwd },
      })}\n`,
      "utf-8",
    );

    // 3. Seed Antigravity (agy) transcript log
    const agyUuid = "95481d27-541f-4b58-8e3f-f6fa29b8ce6b";
    const agyLogDir = join(
      fakeHome,
      ".gemini",
      "antigravity-cli",
      "brain",
      agyUuid,
      ".system_generated",
      "logs",
    );
    mkdirSync(agyLogDir, { recursive: true });
    const agyJsonl = join(agyLogDir, "transcript.jsonl");
    writeFileSync(agyJsonl, '{"step_index":0,"type":"USER_INPUT"}\n', "utf-8");

    const nowSec = Date.now() / 1000;
    utimesSync(claudeJsonl, nowSec, nowSec);
    utimesSync(codexJsonl, nowSec - 5, nowSec - 5);
    utimesSync(agyJsonl, nowSec - 10, nowSec - 10);

    const discovery = new SessionDiscovery({
      homeDir: fakeHome,
      walkAncestors: async () => [
        {
          pid: 4003,
          ppid: 4002,
          comm: "python3",
          args: ["python3", "html-preview.py", "upload", "PLAN.html"],
          env: {},
        },
        {
          pid: 4002,
          ppid: 4001,
          comm: "bash",
          args: ["bash", "-c", "python3 build.py && html-preview upload PLAN.html"],
          env: {},
        },
        {
          pid: 4001,
          ppid: 3900,
          comm: "claude",
          args: ["claude"],
          env: {},
          cwd: projectCwd,
        },
      ],
    });

    const daemon = new HostDaemon({
      paths: {
        configDir: join(root, "cfg"),
        stateDir: join(root, "state"),
      },
      preferredHostName: "MacBook Pro",
      discovery,
      registry: createDefaultRegistry({ homeDir: fakeHome }),
      connectWebSocket: false,
    });
    daemons.push(daemon);
    await daemon.start();

    const resp = await unixSocketPostJson<{
      hostId: string;
      hostName: string;
      binding: string;
    }>(daemon.paths.socketPath, "/v1/prepare-upload", {
      callerPid: 4003,
      callerPpid: 4002,
      sourceFile: "PLAN.html",
    });

    expect(resp.status).toBe(200);
    expect(resp.data.hostName).toBe("MacBook Pro");
    const decoded = decodeOpaqueBinding(resp.data.binding);
    expect(decoded).toEqual({
      v: 1,
      agent: {
        adapter: "claude",
        ref: claudeUuid,
      },
      cwd: projectCwd,
      sourceFile: "PLAN.html",
    });

    const listResp = await unixSocketRequestJson<{
      ok: boolean;
      sessions: Array<{ adapterId: string; sessionRef: string; cwd?: string | null }>;
    }>(daemon.paths.socketPath, "GET", "/v1/sessions");
    expect(listResp.status).toBe(200);
    expect(listResp.data.ok).toBe(true);
    expect(listResp.data.sessions.map(s => `${s.adapterId}:${s.sessionRef}`)).toEqual([
      `claude:${claudeUuid}`,
      `codex:${codexUuid}`,
      `agy:${agyUuid}`,
    ]);
  });

  it("loads bound coding agent over ACP session AND normalizes legacy D1 opaque_binding rows cleanly", async () => {
    const root = makeTempDir("hp-direct-resume-");
    const { server: srv, baseUrl, token } = await bootTestNodeServer(root);
    servers.push(srv);

    const resumedCalls: Array<{ sessionRef: string; promptText: string }> = [];
    const registry = new AdapterRegistry();
    registry.register(
      new ClaudeCodeAdapter({
        executor: async ({ binding, promptText }) => {
          resumedCalls.push({ sessionRef: binding.sessionRef, promptText });
          return {
            replyText: `已直接 resume Claude 会话 (${binding.sessionRef}) 并返回完整答复。`,
          };
        },
      }),
    );

    const daemon = new HostDaemon({
      paths: {
        configDir: join(root, "mac-cfg"),
        stateDir: join(root, "mac-state"),
      },
      preferredHostName: "MacBook Pro",
      explicitCredentials: [{ serverUrl: baseUrl, token }],
      registry,
    });
    daemons.push(daemon);
    await daemon.start();
    const macId = daemon.getIdentity();

    await waitUntil(() => daemon.getConnection(baseUrl)?.getHealth().connected === true);

    // 1. Standard direct coding-agent binding
    const opaque = encodeOpaqueBinding({
      agent: {
        adapter: "claude",
        ref: "claude-uuid-7788",
      },
      cwd: "/Users/apple/demo",
      sourceFile: "PLAN.html",
    });

    const upRes = await fetch(
      `${baseUrl}/upload?name=direct-doc&host_id=${encodeURIComponent(macId.hostId)}&host_name=${encodeURIComponent(macId.hostName)}&binding=${encodeURIComponent(opaque)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "text/html; charset=utf-8",
          Accept: "application/json",
        },
        body: "<!doctype html><html><body><h1>Plan</h1></body></html>",
      },
    );
    expect(upRes.status).toBe(201);
    const uploaded = (await upRes.json()) as { id: string };

    const createRes = await fetch(
      `${baseUrl}/api/archives/${uploaded.id}/interactions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: "req-direct-1",
          baseVersion: 1,
          intent: "change",
          prompt: "为什么没有采用轮询？",
        }),
      },
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { interaction: { id: string } };

    await waitUntil(async () => {
      const stateRes = await fetch(
        `${baseUrl}/api/archives/${uploaded.id}/interactions`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const state = (await stateRes.json()) as {
        interactions: Array<{ id: string; status: string }>;
      };
      return state.interactions.find(i => i.id === created.interaction.id)?.status === "replied";
    });

    expect(resumedCalls).toHaveLength(1);
    expect(resumedCalls[0].sessionRef).toBe("claude-uuid-7788");

    const finalRes = await fetch(
      `${baseUrl}/api/archives/${uploaded.id}/interactions`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const finalJson = (await finalRes.json()) as {
      interactions: Array<{
        effectiveAdapterId: string;
        replyText: string;
      }>;
    };
    expect(finalJson.interactions[0].effectiveAdapterId).toBe("Claude");
    expect(finalJson.interactions[0].replyText).toContain("claude-uuid-7788");

    // 2. Verify legacy D1 opaque_binding payload (containing old primary/fallback fields) decodes cleanly to direct agent
    const legacyRaw = JSON.stringify({
      v: 1,
      primary: { adapter: "legacy_channel", ref: "t10" },
      fallback: { adapter: "claude", ref: "claude-legacy-9900" },
      cwd: "/Users/apple/legacy",
    });
    expect(decodeOpaqueBinding(legacyRaw)).toEqual({
      v: 1,
      agent: { adapter: "claude", ref: "claude-legacy-9900" },
      cwd: "/Users/apple/legacy",
      sourceFile: null,
    });
  });

  it("renews lease periodically during long tasks and aborts local execution on 409 handoff conflict", async () => {
    const root = makeTempDir("hp-lease-renew-");
    const { server: srv, baseUrl, token } = await bootTestNodeServer(root);
    servers.push(srv);

    let renewCount = 0;
    let wasAborted = false;
    let releaseTask!: () => void;
    const taskBlocked = new Promise<void>(resolve => {
      releaseTask = resolve;
    });

    const origFetch = fetch;
    const countingFetch: typeof fetch = async (input, init) => {
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.endsWith("/api/daemon/renew")) {
        renewCount += 1;
      }
      return origFetch(input, init);
    };

    const registry = new AdapterRegistry();
    registry.register(
      new ClaudeCodeAdapter({
        executor: async ({ abortSignal }) => {
          abortSignal?.addEventListener("abort", () => {
            wasAborted = true;
            releaseTask();
          });
          await taskBlocked;
          if (abortSignal?.aborted) {
            throw new Error("aborted");
          }
          return { replyText: "done" };
        },
      }),
    );

    const daemonA = new HostDaemon({
      paths: {
        configDir: join(root, "a-cfg"),
        stateDir: join(root, "a-state"),
      },
      preferredHostName: "Slow Host A",
      explicitCredentials: [{ serverUrl: baseUrl, token }],
      registry,
      connectionOverrides: {
        fetchImpl: countingFetch,
        leaseSeconds: 30,
        leaseRenewIntervalMs: 45,
      },
    });
    daemons.push(daemonA);
    await daemonA.start();
    const hostA = daemonA.getIdentity();
    await waitUntil(() => daemonA.getConnection(baseUrl)?.getHealth().connected === true);

    const upRes = await fetch(
      `${baseUrl}/upload?name=long-job&host_id=${encodeURIComponent(hostA.hostId)}&host_name=${encodeURIComponent(hostA.hostName)}&binding=${encodeURIComponent(encodeOpaqueBinding({ agent: { adapter: "claude", ref: "s1" } }))}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "text/html",
          Accept: "application/json",
        },
        body: "<h1>Long Job</h1>",
      },
    );
    const uploaded = (await upRes.json()) as { id: string };

    const createRes = await fetch(
      `${baseUrl}/api/archives/${uploaded.id}/interactions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: "req-long-1",
          baseVersion: 1,
          prompt: "Run a multi-minute refactor",
        }),
      },
    );
    const created = (await createRes.json()) as { interaction: { id: string } };

    // Wait for at least 2 successful lease renewals
    await waitUntil(() => renewCount >= 2, 3_000);

    const daemonB = new HostDaemon({
      paths: {
        configDir: join(root, "b-cfg"),
        stateDir: join(root, "b-state"),
      },
      preferredHostName: "Fast Host B",
      explicitCredentials: [{ serverUrl: baseUrl, token }],
      registry: new AdapterRegistry(),
    });
    daemons.push(daemonB);
    await daemonB.start();
    const hostB = daemonB.getIdentity();
    await waitUntil(() => daemonB.getConnection(baseUrl)?.getHealth().connected === true);

    // Manually handoff the interaction to online hostB -> invalidates fencingToken -> next renew gets 409 -> aborts!
    const handoffRes = await fetch(
      `${baseUrl}/api/interactions/${created.interaction.id}/handoff`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          targetHostId: hostB.hostId,
          targetHostName: hostB.hostName,
        }),
      },
    );
    expect(handoffRes.status).toBe(200);

    await waitUntil(() => wasAborted === true, 3_000);
    expect(wasAborted).toBe(true);
  });

  it("enters AUTH_REVOKED on 401 without retry spam, recovers on credential reload, and handles wall-clock wake jump", async () => {
    const root = makeTempDir("hp-auth-wake-");
    const { server: srv, baseUrl, token } = await bootTestNodeServer(root);
    servers.push(srv);

    const configDir = join(root, "cfg");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "credentials.json"),
      JSON.stringify({ servers: { [baseUrl]: { token: "revoked-bad-token" } } }),
      "utf-8",
    );

    let fakeNow = Date.now();
    const daemon = new HostDaemon({
      paths: { configDir, stateDir: join(root, "state") },
      preferredHostName: "MacBook",
      connectionOverrides: {
        nowFn: () => fakeNow,
        wakeReconnectDelayMs: 20,
      },
    });
    daemons.push(daemon);
    await daemon.start();

    const conn = daemon.getConnection(baseUrl)!;
    await waitUntil(() => conn.getHealth().state === "auth_revoked");
    expect(conn.getHealth().reconnectAttempts).toBe(0);

    // Fix credentials.json and trigger /v1/reload (simulating fresh `html-preview login`)
    writeFileSync(
      join(configDir, "credentials.json"),
      JSON.stringify({ servers: { [baseUrl]: { token } } }),
      "utf-8",
    );
    const reloadResp = await unixSocketPostJson<{ ok: boolean }>(
      daemon.paths.socketPath,
      "/v1/reload",
      {},
    );
    expect(reloadResp.status).toBe(200);
    await waitUntil(() => conn.getHealth().connected === true);

    // Simulate lid-close sleep + wake (advance wall clock by 45 seconds)
    fakeNow += 45_000;
    expect(conn.checkClockJump(fakeNow)).toBe(true);
    await waitUntil(() => conn.getHealth().connected === true);
  });

  it("runs compiled standalone dist/daemon.mjs bundle outside repo with zero node_modules", async () => {
    const bundleSource = resolve(process.cwd(), "dist/daemon.mjs");
    expect(existsSync(bundleSource)).toBe(true);

    const isolatedRoot = makeTempDir("hp-standalone-bundle-");
    const copiedBundle = join(isolatedRoot, "daemon.mjs");
    copyFileSync(bundleSource, copiedBundle);

    const { server: srv, baseUrl, token } = await bootTestNodeServer(isolatedRoot);
    servers.push(srv);

    const cfgDir = join(isolatedRoot, "cfg");
    const stDir = join(isolatedRoot, "st");
    const sockPath = join(stDir, "daemon.sock");

    const child = spawn(
      process.execPath,
      [
        copiedBundle,
        "serve",
        "--config-dir",
        cfgDir,
        "--state-dir",
        stDir,
        "--socket",
        sockPath,
        "--name",
        "Isolated-Bundle-Host",
        "--url",
        baseUrl,
        "--token",
        token,
      ],
      {
        cwd: isolatedRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      await waitUntil(async () => {
        const h = await probeUnixSocketHealth(sockPath, 400);
        return h?.ok === true && h.servers.some(s => s.connected);
      }, 6_000);

      const health = await probeUnixSocketHealth(sockPath, 500);
      expect(health?.hostName).toBe("Isolated-Bundle-Host");
      expect(health?.servers[0]?.connected).toBe(true);

      // Verify server also sees this standalone daemon in /api/archives/:id/interactions hostPresence!
      const upRes = await fetch(
        `${baseUrl}/upload?name=bundle-doc&host_id=${encodeURIComponent(health!.hostId)}&host_name=${encodeURIComponent(health!.hostName)}&binding=${encodeURIComponent(encodeOpaqueBinding({ agent: { adapter: "claude", ref: "demo-1" }, demoMode: true }))}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "text/html",
            Accept: "application/json",
          },
          body: "<h1>Bundle Test</h1>",
        },
      );
      const uploaded = (await upRes.json()) as { id: string };

      const intRes = await fetch(
        `${baseUrl}/api/archives/${uploaded.id}/interactions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            requestId: "req-bundle-1",
            baseVersion: 1,
            intent: "change",
            prompt: "加上摘要卡片",
          }),
        },
      );
      expect(intRes.status).toBe(201);

      await waitUntil(async () => {
        const listRes = await fetch(
          `${baseUrl}/api/archives/${uploaded.id}/interactions`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const listJson = (await listRes.json()) as {
          interactions: Array<{ status: string; resultVersion: number | null }>;
        };
        return (
          listJson.interactions[0]?.status === "updated" &&
          listJson.interactions[0]?.resultVersion === 2
        );
      }, 6_000);

      // Graceful shutdown via Unix socket
      await unixSocketPostJson(sockPath, "/v1/shutdown", {});
      await new Promise<void>(resolvePromise => {
        child.once("exit", () => resolvePromise());
        setTimeout(resolvePromise, 2_000);
      });
    } finally {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore
      }
    }
  });

  it("defers queued web interactions durably while terminal owns session, delivers FIFO on release, and probes unauthenticated adapters honestly", async () => {
    const root = makeTempDir("hp-defer-fifo-");
    const fakeHome = join(root, "unauth-home");
    mkdirSync(fakeHome, { recursive: true });

    // Honest probe(): unauthenticated Claude and Grok must report available: false
    const unauthClaude = new ClaudeCodeAdapter({
      homeDir: fakeHome,
      env: { ...process.env, HOME: fakeHome, ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "", CLAUDE_CONFIG_DIR: "" },
    });
    const unauthGrok = new GrokAdapter({
      homeDir: fakeHome,
      env: { ...process.env, HOME: fakeHome, XAI_API_KEY: "", GROK_API_KEY: "" },
    });
    expect((await unauthClaude.probe()).available).toBe(false);
    expect((await unauthGrok.probe()).available).toBe(false);

    const { server: srv, baseUrl, token } = await bootTestNodeServer(root);
    servers.push(srv);

    const stateDir = join(root, "state");
    const lockFile = join(stateDir, "locks", "agy__agy-sess-fifo.lock");
    const rpcLog = join(root, "daemon-acp-rpc.jsonl");
    const fixture = resolve(process.cwd(), "test/fixtures/acp-agent.mjs");

    const agyLogDir = join(fakeHome, ".gemini/antigravity-cli/brain/agy-sess-fifo/.system_generated/logs");
    mkdirSync(agyLogDir, { recursive: true });
    writeFileSync(
      join(agyLogDir, "transcript.jsonl"),
      JSON.stringify({ step_index: 0, type: "PLANNER_RESPONSE", status: "DONE", content: "initial" }) + "\n",
    );

    const lockHolder = await new Promise<ReturnType<typeof spawn>>((resHolder, rejHolder) => {
      const py = [
        "import fcntl, json, os, signal, sys, time",
        "lp = sys.argv[1]",
        "os.makedirs(os.path.dirname(lp), exist_ok=True)",
        "fd = open(lp, 'a+', encoding='utf-8')",
        "fcntl.flock(fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)",
        "open(lp[:-5] + '.owner.json', 'w', encoding='utf-8').write(json.dumps({'adapterId': 'agy', 'sessionId': 'agy-sess-fifo', 'pid': os.getpid()}))",
        "signal.signal(signal.SIGINT, lambda *_: sys.exit(0))",
        "sys.stdout.write('LOCKED\\n'); sys.stdout.flush()",
        "while True:\n    time.sleep(0.05)",
      ].join("\n");
      const proc = spawn("python3", ["-c", py, lockFile], { stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout!.on("data", d => {
        if (d.toString("utf-8").includes("LOCKED")) resHolder(proc);
      });
      proc.once("error", rejHolder);
    });

    try {
      const testEnv = { ...process.env, HOME: fakeHome, AGY_BIN: fixture, ACP_LOG_FILE: rpcLog };
      const registry = new AdapterRegistry();
      registry.register(new AgyAdapter({ binary: fixture, homeDir: fakeHome, env: testEnv }));

      const daemon = new HostDaemon({
        paths: {
          configDir: join(root, "cfg"),
          stateDir,
        },
        preferredHostName: "Queue-Box",
        explicitCredentials: [{ serverUrl: baseUrl, token }],
        registry,
        connectionOverrides: {
          homeDir: fakeHome,
          env: testEnv,
        },
      });
      daemons.push(daemon);
      await daemon.start();
      const host = daemon.getIdentity();
      await waitUntil(() => daemon.getConnection(baseUrl)?.getHealth().connected === true);

      const opaque = encodeOpaqueBinding({
        agent: { adapter: "agy", ref: "agy-sess-fifo" },
        cwd: root,
        sourceFile: "PLAN.html",
      });
      const upRes = await fetch(
        `${baseUrl}/upload?name=fifo-doc&host_id=${encodeURIComponent(host.hostId)}&host_name=${encodeURIComponent(host.hostName)}&binding=${encodeURIComponent(opaque)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "text/html",
            Accept: "application/json",
          },
          body: "<h1>FIFO Queue Test</h1>",
        },
      );
      const uploaded = (await upRes.json()) as { id: string };

      // Send two web messages while external terminal holds OS flock on the session
      for (const [idx, msg] of ["First web edit", "Second web edit"].entries()) {
        const res = await fetch(`${baseUrl}/api/archives/${uploaded.id}/interactions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            requestId: `req-fifo-${idx + 1}`,
            baseVersion: 1,
            intent: "change",
            prompt: msg,
          }),
        });
        expect(res.status).toBe(201);
      }

      // Give daemon time to claim, enter spectating, and defer both — neither may show fake `working` or `failed`!
      await new Promise(r => setTimeout(r, 300));
      const midRes = await fetch(`${baseUrl}/api/archives/${uploaded.id}/interactions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const midJson = (await midRes.json()) as {
        interactions: Array<{ prompt: string; status: string; progressText: string | null }>;
      };
      expect(midJson.interactions.map(i => i.status)).toEqual(["pending", "pending"]);
      expect(existsSync(rpcLog)).toBe(false);

      // Terminal exits cleanly (SIGINT) -> AcpSessionManager sweep detects exit -> cold loads -> auto-drains FIFO!
      lockHolder.kill("SIGINT");
      await waitUntil(() => lockHolder.exitCode !== null, 3_000);

      await waitUntil(async () => {
        const doneRes = await fetch(`${baseUrl}/api/archives/${uploaded.id}/interactions`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const doneJson = (await doneRes.json()) as {
          interactions: Array<{ status: string; replyText: string }>;
        };
        return doneJson.interactions.length === 2 && doneJson.interactions.every(i => i.status === "replied");
      }, 6_000);

      const rpcEntries = readFileSync(rpcLog, "utf-8")
        .trim()
        .split("\n")
        .map(l => JSON.parse(l) as { method: string; params?: { prompt?: Array<{ text: string }> } });
      const promptCalls = rpcEntries.filter(e => e.method === "session/prompt").map(e => e.params?.prompt?.[0]?.text || "");
      expect(promptCalls).toHaveLength(2);
      expect(promptCalls[0]).toContain("First web edit");
      expect(promptCalls[1]).toContain("Second web edit");

      // Verify /v1/release-session yields the warm ACP session cleanly
      const relResp = await unixSocketPostJson<{ ok: boolean; released: boolean }>(
        daemon.paths.socketPath,
        "/v1/release-session",
        { adapterId: "agy", sessionId: "agy-sess-fifo" },
      );
      expect(relResp.status).toBe(200);
      expect(relResp.data.ok).toBe(true);
      expect(relResp.data.released).toBe(true);
    } finally {
      try { lockHolder.kill("SIGKILL"); } catch {}
    }
  }, 15_000);

  it("enforces single instance under concurrent startup, recovers SIGKILL stale lock+socket, keeps /v1/health non-blocking, and ships skill bundle", async () => {
    const distBundle = resolve(process.cwd(), "dist/daemon.mjs");
    const skillBundle = resolve(process.cwd(), "skills/html-preview/scripts/daemon.mjs");
    expect(existsSync(distBundle)).toBe(true);
    expect(existsSync(skillBundle)).toBe(true);
    expect(readFileSync(skillBundle).equals(readFileSync(distBundle))).toBe(true);

    // 1. In-process concurrent HostDaemon.start() + slow adapter probe
    const inProcRoot = makeTempDir("hp-inproc-race-");
    const slowRegistry = new AdapterRegistry();
    const slowClaude = new ClaudeCodeAdapter({ executor: async () => ({ replyText: "ok" }) });
    slowClaude.probe = async () => {
      await new Promise(r => setTimeout(r, 700));
      return { available: true, version: "slow-1.0" };
    };
    slowRegistry.register(slowClaude);

    const contenders = Array.from({ length: 4 }, () =>
      new HostDaemon({
        paths: {
          configDir: join(inProcRoot, "cfg"),
          stateDir: join(inProcRoot, "state"),
        },
        registry: slowRegistry,
        connectWebSocket: false,
      }),
    );

    const outcomes = await Promise.allSettled(contenders.map(d => d.start()));
    const winners = contenders.filter((_, i) => outcomes[i].status === "fulfilled");
    const losers = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(3);
    for (const l of losers) {
      expect(l.reason).toBeInstanceOf(DaemonAlreadyRunningError);
    }
    daemons.push(winners[0]);

    // Stopping losers must NEVER unlink the winner's socket or lock
    for (const c of contenders) {
      if (c !== winners[0]) {
        await c.stop(500);
      }
    }
    expect(existsSync(winners[0].paths.socketPath)).toBe(true);
    expect(existsSync(winners[0].paths.lockFile)).toBe(true);

    // Liveness /v1/health responds quickly (<250ms) even while slow adapter probe is still running
    const t0 = Date.now();
    const fastHealth = await probeUnixSocketHealth(winners[0].paths.socketPath, 500);
    expect(Date.now() - t0).toBeLessThan(350);
    expect(fastHealth?.ok).toBe(true);

    // Full status /v1/health?full=1 waits for cold probe and returns availableAgents accurately
    const fullHealth = await unixSocketRequestJson<{ ok: boolean; availableAgents: string[] }>(
      winners[0].paths.socketPath,
      "GET",
      "/v1/health?full=1",
    );
    expect(fullHealth.status).toBe(200);
    expect(fullHealth.data.availableAgents).toEqual(["claude"]);

    await winners[0].stop(1_000);
    daemons.pop();
    expect(existsSync(winners[0].paths.socketPath)).toBe(false);
    expect(existsSync(winners[0].paths.lockFile)).toBe(false);

    // 2. Multi-process OS concurrent stampede using skills/html-preview/scripts/daemon.mjs
    const procRoot = makeTempDir("hp-proc-race-");
    const cfgDir = join(procRoot, "cfg");
    const stDir = join(procRoot, "st");
    const sockPath = join(stDir, "daemon.sock");
    const logFile = join(stDir, "logs", "daemon.log");

    const spawnServe = (ifNotRunning: boolean) => {
      const args = [
        skillBundle,
        "serve",
        "--config-dir",
        cfgDir,
        "--state-dir",
        stDir,
        "--socket",
        sockPath,
        "--log-file",
        logFile,
        ...(ifNotRunning ? ["--if-not-running"] : []),
      ];
      const child = spawn(process.execPath, args, {
        cwd: procRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exitPromise = new Promise<number | null>(res => {
        child.once("exit", code => res(code));
      });
      return { child, exitPromise };
    };

    const wave1 = Array.from({ length: 6 }, () => spawnServe(true));
    try {
      await waitUntil(async () => (await probeUnixSocketHealth(sockPath, 500))?.ok === true, 6_000);
      const live1 = await probeUnixSocketHealth(sockPath, 500);
      expect(live1?.ok).toBe(true);
      const winner1Pid = live1!.pid;

      const loser1Exits = await Promise.all(
        wave1.filter(w => w.child.pid !== winner1Pid).map(w => w.exitPromise),
      );
      expect(loser1Exits).toEqual([0, 0, 0, 0, 0]);
      const winner1 = wave1.find(w => w.child.pid === winner1Pid)!;
      expect(winner1.child.exitCode).toBeNull();

      // Without --if-not-running, starting another instance exits cleanly with code 1 without unlinking socket
      const strictDup = spawnServe(false);
      expect(await strictDup.exitPromise).toBe(1);
      expect((await probeUnixSocketHealth(sockPath, 500))?.pid).toBe(winner1Pid);

      // Simulate hard crash (SIGKILL) leaving stale daemon.lock, daemon.pid, and daemon.sock behind
      winner1.child.kill("SIGKILL");
      await winner1.exitPromise;
      expect(existsSync(sockPath)).toBe(true);
      expect(existsSync(join(stDir, "daemon.lock"))).toBe(true);

      // Concurrent wave 2 recovers stale lock + stale socket atomically with exactly 1 survivor
      const wave2 = Array.from({ length: 4 }, () => spawnServe(true));
      try {
        await waitUntil(async () => {
          const h = await probeUnixSocketHealth(sockPath, 500);
          return h?.ok === true && h.pid !== winner1Pid;
        }, 6_000);
        const live2 = await probeUnixSocketHealth(sockPath, 500);
        expect(live2?.ok).toBe(true);
        const winner2Pid = live2!.pid;

        const loser2Exits = await Promise.all(
          wave2.filter(w => w.child.pid !== winner2Pid).map(w => w.exitPromise),
        );
        expect(loser2Exits).toEqual([0, 0, 0]);

        await unixSocketPostJson(sockPath, "/v1/shutdown", {});
        const winner2 = wave2.find(w => w.child.pid === winner2Pid)!;
        await winner2.exitPromise;
      } finally {
        for (const w of wave2) {
          try { w.child.kill("SIGKILL"); } catch {}
        }
      }
    } finally {
      for (const w of wave1) {
        try { w.child.kill("SIGKILL"); } catch {}
      }
    }
  }, 20_000);
});
