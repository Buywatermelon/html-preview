#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import { WebSocket } from "ws";
import { startLocalS3Mock } from "./local-s3-mock.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const PYTHON_CLI = join(REPO_ROOT, "skills/html-preview/scripts/html-preview.py");
const MIGRATIONS_DIR = join(REPO_ROOT, "migrations");
const WORKER_MAIN = join(REPO_ROOT, "src/index.ts");

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitFor(predicate, label, timeoutMs = 15000, intervalMs = 40) {
  const started = Date.now();
  while (true) {
    const val = await predicate();
    if (val) return val;
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`Timed out waiting for: ${label} (${timeoutMs}ms)`);
    }
    await sleep(intervalMs);
  }
}

function getFreePort(host = "127.0.0.1") {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createNetServer();
    srv.once("error", rejectPort);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(err => (err ? rejectPort(err) : resolvePort(port)));
    });
  });
}

function runExecFile(cmd, args, options = {}) {
  return new Promise((resolveExec, rejectExec) => {
    execFile(
      cmd,
      args,
      {
        cwd: options.cwd || REPO_ROOT,
        env: options.env || process.env,
        timeout: options.timeoutMs ?? 60000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message || "").toString().trim();
          rejectExec(new Error(`${cmd} ${args.join(" ")} failed: ${detail}`));
          return;
        }
        resolveExec({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function runPythonCliJson(args, { cwd, baseUrl, token, extraEnv = {} }) {
  // Scrub any outer container session env vars unless explicitly set in extraEnv
  const cleanEnv = { ...process.env };
  for (const k of [
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_SESSION_ID",
    "CLAUDECODE",
    "ANTIGRAVITY_CONVERSATION_ID",
    "AGY_SESSION_ID",
    "AGY_CONVERSATION_ID",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "HTML_PREVIEW_INTERACTION_ID",
  ]) {
    delete cleanEnv[k];
  }

  const { stdout } = await runExecFile("python3", [PYTHON_CLI, ...args], {
    cwd,
    env: {
      ...cleanEnv,
      HTML_PREVIEW_URL: baseUrl,
      HTML_PREVIEW_TOKEN: token,
      XDG_CONFIG_HOME: join(cwd, ".xdg-config"),
      ...extraEnv,
    },
  });
  return JSON.parse(stdout);
}

/**
 * Local HTTP mock push endpoint receiver.
 */
async function startLocalPushReceiver() {
  /** @type {Array<{ path: string; payload: any; receivedAt: string }>} */
  const deliveries = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = { raw: text };
      }
      deliveries.push({
        path: req.url || "/",
        payload,
        receivedAt: new Date().toISOString(),
      });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res(undefined));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    deliveries,
    clear() {
      deliveries.length = 0;
    },
    close() {
      return new Promise(r => server.close(() => r(undefined)));
    },
  };
}

async function buildRuntimeModules(tmpRoot) {
  symlinkSync(MIGRATIONS_DIR, join(tmpRoot, "migrations"), "dir");
  const bundleDir = join(tmpRoot, "dist");
  mkdirSync(bundleDir, { recursive: true });
  const outfile = join(bundleDir, "demo-runtime-bundle.mjs");
  await esbuild({
    stdin: {
      contents: `
        export { startNodePreviewServer } from "./src/node-server";
        export { S3Store } from "./src/storage";
        export { HostDaemon } from "./src/daemon/server";
        export { SessionDiscovery } from "./src/daemon/discovery";
        export { createDefaultRegistry } from "./src/daemon/registry";
      `,
      resolveDir: REPO_ROOT,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    banner: {
      js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    },
    outfile,
  });
  return import(pathToFileURL(outfile).href);
}

function seedHostIdentityFile(configDir, hostId, hostName, platform = "darwin") {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "host.json"),
    JSON.stringify(
      {
        hostId,
        hostName,
        platform,
        arch: "arm64",
        createdAt: "2026-11-14T00:00:00.000Z",
      },
      null,
      2,
    ),
    "utf8",
  );
}

/**
 * Executes the full end-to-end verification scenario suite against a live runtime URL
 * (used identically for Part 1 Self-Hosted Node AND Part 2 Cloudflare `wrangler dev --local`!).
 */
async function runScenarioSuite({
  runtimeLabel,
  baseUrl,
  workDir,
  pushReceiver,
  modules,
  onVerifySocketCounts,
}) {
  const { HostDaemon, SessionDiscovery, createDefaultRegistry } = modules;
  pushReceiver.clear();

  // Step A: Authenticate via POST /auth/dev-login (session cookie + deviceToken)
  const devLoginRes = await fetch(`${baseUrl}/auth/dev-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      login: "alice",
      issueDeviceToken: true,
      deviceName: `${runtimeLabel} Dev Login`,
    }),
  });
  assert.equal(devLoginRes.status, 200, `${runtimeLabel}: dev-login failed`);
  const devLoginBody = await devLoginRes.json();
  const sessionCookie = devLoginRes.headers
    .getSetCookie()
    .find(c => c.startsWith("hp_session="))
    ?.split(";")[0];
  assert.ok(sessionCookie, `${runtimeLabel}: missing hp_session cookie`);
  assert.match(devLoginBody.deviceToken, /^hpd_/);
  const userId = devLoginBody.user.id;

  // Step B: Also exercise RFC 8628 CLI Device Code Flow (code -> approve -> token)
  const codeRes = await fetch(`${baseUrl}/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: `${runtimeLabel} RFC8628 CLI` }),
  });
  assert.equal(codeRes.status, 200);
  const codeData = await codeRes.json();
  assert.ok(codeData.device_code && codeData.user_code);

  const approveRes = await fetch(`${baseUrl}/api/auth/device/approve`, {
    method: "POST",
    headers: {
      Cookie: sessionCookie,
      Origin: baseUrl,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      user_code: codeData.user_code,
      action: "approve",
    }),
  });
  assert.equal(approveRes.status, 200);

  const tokenRes = await fetch(`${baseUrl}/auth/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: codeData.device_code }),
  });
  assert.equal(tokenRes.status, 200);
  const tokenData = await tokenRes.json();
  const cliToken = tokenData.access_token;
  assert.match(cliToken, /^hpd_/);

  // Step C: Register 2 Web Push subscriptions (device-older, then 40ms later device-newer)
  const subOlder = await fetch(`${baseUrl}/api/push/subscriptions`, {
    method: "POST",
    headers: {
      Cookie: sessionCookie,
      Origin: baseUrl,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      endpoint: `${pushReceiver.url}/device-older`,
      keys: { p256dh: "p256dh_older_demo", auth: "auth_older_demo" },
      userAgent: "Older iPad PWA",
    }),
  });
  assert.equal(subOlder.status, 201);

  await sleep(40); // Guarantee strictly newer ISO updated_at timestamp for device-newer

  const subNewer = await fetch(`${baseUrl}/api/push/subscriptions`, {
    method: "POST",
    headers: {
      Cookie: sessionCookie,
      Origin: baseUrl,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      endpoint: `${pushReceiver.url}/device-newer`,
      keys: { p256dh: "p256dh_newer_demo", auth: "auth_newer_demo" },
      userAgent: "Newer Mobile Phone PWA",
    }),
  });
  assert.equal(subNewer.status, 201);

  // Step D: Start TWO real persistent HostDaemons simultaneously under the SAME user account:
  //   1) `macDaemon` ("MacBook Pro", hst_mac01)
  //   2) `boxDaemon` ("grok-bot-box", hst_box02)
  const macRoot = join(workDir, "mac-host");
  const boxRoot = join(workDir, "box-host");
  const macSock = join(macRoot, "daemon.sock");
  const boxSock = join(boxRoot, "daemon.sock");
  seedHostIdentityFile(join(macRoot, "cfg"), "hst_mac01", "MacBook Pro", "darwin");
  seedHostIdentityFile(join(boxRoot, "cfg"), "hst_box02", "grok-bot-box", "linux");

  let macDeliveredCount = 0;
  let boxDeliveredCount = 0;

  const macDiscovery = new SessionDiscovery({
    homeDir: macRoot,
    walkAncestors: async () => [],
  });

  const boxDiscovery = new SessionDiscovery({
    homeDir: boxRoot,
    walkAncestors: async () => [],
  });

  const macRegistry = createDefaultRegistry({
    acpExecutor: async ({ agentId, binding, envelope, envelopePath }) => {
      macDeliveredCount += 1;
      assert.equal(agentId, "claude");
      assert.equal(binding.sessionRef, "claude-sess-demo-77");
      assert.equal(statSync(envelopePath).mode & 0o777, 0o600, "Envelope file must be 0600");

      if (envelope.intent === "change") {
        const v2Path = join(workDir, "deliverable-v2.html");
        writeFileSync(
          v2Path,
          [
            "<!doctype html>",
            "<html><head><meta charset='utf-8'><title>Latency Report</title></head>",
            "<body><h1>Hero Latency: 85ms</h1><span class='badge'>Optimized v2 on MacBook Pro</span></body></html>",
          ].join("\n"),
          "utf8",
        );
        const upV2 = await runPythonCliJson(
          [
            "upload",
            v2Path,
            "--url",
            baseUrl,
            "--name",
            "latency-report",
            "--project",
            "interact-demo",
            "--task",
            "dual-runtime",
            "--note",
            "Optimized latency from 420ms to 85ms",
          ],
          {
            cwd: workDir,
            baseUrl,
            token: cliToken,
            extraEnv: {
              HTML_PREVIEW_DAEMON_SOCK: macSock,
              HTML_PREVIEW_INTERACTION_ID: envelope.interactionId,
              CLAUDE_SESSION_ID: binding.sessionRef,
            },
          },
        );
        return {
          newVersion: upV2.version,
          replyText: `Resumed Claude (${binding.sessionRef}), uploaded v${upV2.version} (85ms), and returned full reply.`,
        };
      }

      return {
        replyText: `Resumed Claude (${binding.sessionRef}) on MacBook Pro and answered: "${envelope.ownerPrompt}".`,
      };
    },
  });

  const boxRegistry = createDefaultRegistry({
    acpExecutor: async ({ agentId, binding, envelope }) => {
      boxDeliveredCount += 1;
      assert.equal(agentId, "claude");

      // Handoff from sleeping MacBook Pro -> locateArtifactSource materialized online HTML snapshot in boxRoot!
      if (envelope.binding.adapterMeta?.handoffFromHostId === "hst_mac01") {
        assert.ok(
          envelope.binding.cwd?.startsWith(boxRoot),
          `Expected handoff cwd inside boxRoot (${boxRoot}), got: ${envelope.binding.cwd}`,
        );
        assert.equal(envelope.binding.sourceFile, "index.html");
        const onlineHtml = readFileSync(
          join(envelope.binding.cwd, envelope.binding.sourceFile),
          "utf8",
        );
        assert.match(onlineHtml, /Hero Latency: 85ms/);

        const v3Path = join(workDir, "deliverable-v3-handoff.html");
        writeFileSync(
          v3Path,
          onlineHtml.replace(
            "</body>",
            "<footer class='handoff'>Handed off to grok-bot-box v3</footer></body>",
          ),
          "utf8",
        );
        const upV3 = await runPythonCliJson(
          [
            "upload",
            v3Path,
            "--url",
            baseUrl,
            "--name",
            envelope.document.name,
            "--project",
            "interact-demo",
            "--task",
            "dual-runtime",
            "--note",
            "Handed off to grok-bot-box while MacBook Pro was asleep",
          ],
          {
            cwd: workDir,
            baseUrl,
            token: cliToken,
            extraEnv: {
              HTML_PREVIEW_DAEMON_SOCK: boxSock,
              HTML_PREVIEW_INTERACTION_ID: envelope.interactionId,
              CLAUDE_SESSION_ID: "claude-box-handoff-01",
            },
          },
        );
        return {
          newVersion: upV3.version,
          sessionRef: "claude-box-handoff-01",
          replyText: `grok-bot-box took over from sleeping MacBook Pro and published v${upV3.version}!`,
        };
      }

      if (!binding.sessionRef || binding.sessionRef === "adhoc" || binding.sessionRef === "auto") {
        return {
          sessionRef: "claude-adhoc-demo-99",
          replyText: `Fresh adhoc ${agentId} turn on grok-bot-box answered "${envelope.ownerPrompt}" without manual binding.`,
        };
      }
      if (binding.sessionRef === "claude-adhoc-demo-99") {
        return {
          replyText: `Resumed ${agentId} (${binding.sessionRef}) on grok-bot-box follow-up turn: "${envelope.ownerPrompt}".`,
        };
      }
      throw new Error(`Unexpected sessionRef on boxDaemon: ${binding.sessionRef}`);
    },
  });

  const createMacDaemon = () =>
    new HostDaemon({
      paths: {
        configDir: join(macRoot, "cfg"),
        stateDir: join(macRoot, "state"),
        dataDir: join(macRoot, "data"),
        socketPath: macSock,
        logFile: join(macRoot, "state/daemon.log"),
      },
      explicitCredentials: [{ serverUrl: baseUrl, token: cliToken }],
      registry: macRegistry,
      discovery: macDiscovery,
      logToStderr: false,
    });

  let macDaemon = createMacDaemon();
  const boxDaemon = new HostDaemon({
    paths: {
      configDir: join(boxRoot, "cfg"),
      stateDir: join(boxRoot, "state"),
      dataDir: join(boxRoot, "data"),
      socketPath: boxSock,
      logFile: join(boxRoot, "state/daemon.log"),
    },
    explicitCredentials: [{ serverUrl: baseUrl, token: cliToken }],
    registry: boxRegistry,
    discovery: boxDiscovery,
    logToStderr: false,
  });

  /** @type {WebSocket | null} */
  let browserWs = null;

  try {
    await macDaemon.start();
    await boxDaemon.start();

    /** @type {Array<any>} */
    const browserEvents = [];
    const wsOriginUrl = baseUrl.replace(/^http:/i, "ws:");
    browserWs = new WebSocket(`${wsOriginUrl}/api/events`, {
      headers: {
        Cookie: sessionCookie,
        Origin: baseUrl,
      },
    });
    await new Promise((resolveOpen, rejectOpen) => {
      browserWs.once("open", () => resolveOpen(undefined));
      browserWs.once("error", rejectOpen);
    });
    browserWs.on("message", raw => {
      const str = String(raw);
      if (str.startsWith("{")) {
        try {
          browserEvents.push(JSON.parse(str));
        } catch {}
      }
    });

    if (onVerifySocketCounts) {
      await onVerifySocketCounts(userId, { browser: 1, daemon: 2 });
    } else {
      await waitFor(async () => {
        const mh = await macDaemon.getHealth();
        const bh = await boxDaemon.getHealth();
        return mh.servers[0]?.connected && bh.servers[0]?.connected;
      }, `${runtimeLabel} both daemons WS connected`);
    }

    // Step E: Upload v1 HTML via Python CLI talking ONLY to MacBook Pro's local daemon.sock
    const v1Path = join(workDir, "deliverable-v1.html");
    writeFileSync(
      v1Path,
      [
        "<!doctype html>",
        "<html><head><meta charset='utf-8'><title>Latency Report</title></head>",
        "<body><h1>Hero Latency: 420ms</h1><p>Initial benchmark report v1.</p></body></html>",
      ].join("\n"),
      "utf8",
    );

    const uploadedV1 = await runPythonCliJson(
      [
        "upload",
        v1Path,
        "--url",
        baseUrl,
        "--name",
        "latency-report",
        "--project",
        "interact-demo",
        "--task",
        "dual-runtime",
        "--title",
        "Latency Report",
        "--bind",
      ],
      {
        cwd: workDir,
        baseUrl,
        token: cliToken,
        extraEnv: {
          HTML_PREVIEW_DAEMON_SOCK: macSock,
          CLAUDE_SESSION_ID: "claude-sess-demo-77",
        },
      },
    );
    assert.equal(uploadedV1.version, 1);
    assert.equal(uploadedV1.binding?.hostId, "hst_mac01");
    assert.equal(uploadedV1.binding?.hostName, "MacBook Pro");
    assert.equal(uploadedV1.binding?.adapterId, "claude");
    const docId = uploadedV1.id;

    // Verify onlineHosts reports BOTH MacBook Pro AND grok-bot-box simultaneously online
    const initPresence = await (
      await fetch(`${baseUrl}/api/archives/${docId}/interactions`, {
        headers: { Cookie: sessionCookie },
      })
    ).json();
    assert.equal(initPresence.onlineHosts?.length, 2, `${runtimeLabel}: expected 2 online hosts`);

    // =========================================================================
    // Scenario 1: Both Mac & Box online -> Direct Claude resume on Mac claims & replies, Box steals 0!
    // =========================================================================
    const int1Res = await fetch(`${baseUrl}/api/archives/${docId}/interactions`, {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: baseUrl,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: `${runtimeLabel}-scen1`,
        intent: "question",
        anchor: { entryPath: "index.html", exact: "Hero Latency: 420ms" },
        prompt: "Why was initial p99 latency 420ms?",
      }),
    });
    assert.equal(int1Res.status, 201);
    const int1 = (await int1Res.json()).interaction;
    assert.equal(int1.targetHostId, "hst_mac01");

    await waitFor(
      () =>
        browserEvents.some(
          e =>
            e.type === "interaction" &&
            e.interaction?.id === int1.id &&
            e.interaction?.status === "replied",
        ),
      `${runtimeLabel} Scenario 1 browser WS 'replied'`,
    );
    assert.equal(boxDeliveredCount, 0, `${runtimeLabel}: grok-bot-box must NEVER steal MacBook Pro's job`);
    assert.equal(
      pushReceiver.deliveries.length,
      0,
      `${runtimeLabel}: active browser WS must suppress Web Push in Scenario 1`,
    );

    // =========================================================================
    // Scenario 2: Direct Claude resume on Mac modifies HTML -> uploads v2 + returns complete reply
    // =========================================================================
    const int2Res = await fetch(`${baseUrl}/api/archives/${docId}/interactions`, {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: baseUrl,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: `${runtimeLabel}-scen2`,
        intent: "change",
        anchor: { entryPath: "index.html", exact: "Hero Latency: 420ms" },
        prompt: "Optimize hero latency to 85ms and publish v2.",
      }),
    });
    assert.equal(int2Res.status, 201);
    const int2 = (await int2Res.json()).interaction;

    await waitFor(
      () =>
        browserEvents.some(
          e =>
            e.type === "interaction" &&
            e.interaction?.id === int2.id &&
            e.interaction?.status === "updated" &&
            Boolean(e.interaction?.replyText),
        ),
      `${runtimeLabel} Scenario 2 direct resume 'updated' with replyText`,
    );

    const stateAfterScen2 = await (
      await fetch(`${baseUrl}/api/archives/${docId}/interactions`, {
        headers: { Cookie: sessionCookie },
      })
    ).json();
    const int2Final = stateAfterScen2.interactions.find(i => i.id === int2.id);
    assert.ok(int2Final);
    assert.equal(int2Final.status, "updated");
    assert.equal(int2Final.resultVersion, 2);
    assert.equal(int2Final.effectiveAdapterId, "Claude");
    assert.match(int2Final.replyText, /Resumed Claude \(claude-sess-demo-77\)/);
    assert.equal(boxDeliveredCount, 0, `${runtimeLabel}: grok-bot-box must NEVER steal Scenario 2`);
    assert.equal(
      pushReceiver.deliveries.length,
      0,
      `${runtimeLabel}: active browser WS must suppress Web Push in Scenario 2`,
    );

    // =========================================================================
    // Scenario 3A: MacBook Pro Lid Closed (offline) while grok-bot-box stays online:
    //   -> Comment queues safely (`targetHostOnline: false`), Box does NOT steal,
    //   -> Phone screen locks (Browser WS closes) -> MacBook Pro wakes -> auto-drains & pushes ONLY to `/device-newer`!
    // =========================================================================
    await macDaemon.stop();
    if (onVerifySocketCounts) {
      await onVerifySocketCounts(userId, { browser: 1, daemon: 1 });
    } else {
      await waitFor(async () => {
        const st = await (
          await fetch(`${baseUrl}/api/archives/${docId}/interactions`, {
            headers: { Cookie: sessionCookie },
          })
        ).json();
        return st.onlineHosts?.length === 1 && st.onlineHosts[0]?.hostId === "hst_box02";
      }, `${runtimeLabel} Mac offline while Box remains online`);
    }

    const int3aRes = await fetch(`${baseUrl}/api/archives/${docId}/interactions`, {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: baseUrl,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: `${runtimeLabel}-scen3a-sleep`,
        intent: "question",
        prompt: "Queued on phone while MacBook Pro lid is closed.",
      }),
    });
    assert.equal(int3aRes.status, 201);
    const int3aBody = await int3aRes.json();
    const int3a = int3aBody.interaction;
    assert.equal(int3a.status, "pending");
    assert.equal(int3aBody.hostPresence?.targetHostOnline, false);
    assert.equal(int3aBody.hostPresence?.onlineHosts?.[0]?.hostId, "hst_box02");

    await sleep(250);
    assert.equal(boxDeliveredCount, 0, `${runtimeLabel}: grok-bot-box must NOT steal sleeping Mac queue`);

    await new Promise(resolveClose => {
      browserWs.once("close", () => resolveClose(undefined));
      browserWs.close();
    });
    browserWs = null;

    macDaemon = createMacDaemon();
    await macDaemon.start();

    await waitFor(
      () => pushReceiver.deliveries.some(d => d.payload?.interactionId === int3a.id),
      `${runtimeLabel} Scenario 3A wake auto-drain + single-device Web Push`,
    );

    const scen3Pushes = pushReceiver.deliveries.filter(d => d.payload?.interactionId === int3a.id);
    assert.equal(scen3Pushes.length, 1, `${runtimeLabel}: expected exactly 1 offline push`);
    assert.equal(
      scen3Pushes[0].path,
      "/device-newer",
      `${runtimeLabel}: must push ONLY to single most recently active device`,
    );
    assert.equal(
      pushReceiver.deliveries.some(d => d.path === "/device-older"),
      false,
      `${runtimeLabel}: must NEVER spam older push device`,
    );

    // =========================================================================
    // Scenario 3B: MacBook Pro Lid Closed again -> Explicit Handoff (`POST /api/interactions/:id/handoff`) to grok-bot-box
    // =========================================================================
    await macDaemon.stop();
    browserWs = new WebSocket(`${wsOriginUrl}/api/events`, {
      headers: { Cookie: sessionCookie, Origin: baseUrl },
    });
    await new Promise((resOpen, rejOpen) => {
      browserWs.once("open", () => resOpen(undefined));
      browserWs.once("error", rejOpen);
    });
    browserWs.on("message", raw => {
      const str = String(raw);
      if (str.startsWith("{")) {
        try {
          browserEvents.push(JSON.parse(str));
        } catch {}
      }
    });

    const int3bRes = await fetch(`${baseUrl}/api/archives/${docId}/interactions`, {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: baseUrl,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: `${runtimeLabel}-scen3b-handoff`,
        intent: "change",
        prompt: "Urgent fix needed now — hand off to online grok-bot-box.",
      }),
    });
    assert.equal(int3bRes.status, 201);
    const int3b = (await int3bRes.json()).interaction;
    assert.equal(int3b.status, "pending");
    assert.equal(int3b.targetHostId, "hst_mac01");

    const handoffRes = await fetch(`${baseUrl}/api/interactions/${int3b.id}/handoff`, {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: baseUrl,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targetHostId: "hst_box02",
        targetHostName: "grok-bot-box",
      }),
    });
    assert.equal(handoffRes.status, 200, `${runtimeLabel}: explicit handoff must return 200`);

    await waitFor(
      () =>
        browserEvents.some(
          e =>
            e.type === "interaction" &&
            e.interaction?.id === int3b.id &&
            e.interaction?.status === "updated" &&
            e.interaction?.resultVersion === 3,
        ),
      `${runtimeLabel} Scenario 3B handoff to grok-bot-box v3 'updated'`,
    );
    assert.equal(boxDeliveredCount, 1);

    // =========================================================================
    // Scenario 4: Zero-Manual-Binding Historical Unbound Page + UI Bundle Audit
    // =========================================================================
    const clientJsText = await (await fetch(`${baseUrl}/assets/client.js`)).text();
    assert.match(clientJsText, /hp-composer-box/, `${runtimeLabel}: missing unified composer class`);
    assert.match(clientJsText, /已加入队列/, `${runtimeLabel}: missing sleep queue notice in client.js`);
    assert.match(clientJsText, /改由在线机器/, `${runtimeLabel}: missing handoff button text in client.js`);
    assert.doesNotMatch(
      clientJsText,
      /已自动切换至直连/,
      `${runtimeLabel}: removed orchestrator fallback badge must NOT appear in client.js`,
    );
    assert.doesNotMatch(
      clientJsText,
      /终端已完成本轮执行/,
      `${runtimeLabel}: removed terminal turn_completed copy must NOT appear in client.js`,
    );

    const unboundPath = join(workDir, "legacy-unbound.html");
    writeFileSync(
      unboundPath,
      "<!doctype html><html><head><meta charset='utf-8'><title>Legacy Unbound Page</title></head><body><h1>Legacy Architecture</h1></body></html>",
      "utf8",
    );
    const uploadedUnbound = await runPythonCliJson(
      [
        "upload",
        unboundPath,
        "--url",
        baseUrl,
        "--name",
        "legacy-unbound",
        "--project",
        "interact-demo",
        "--task",
        "legacy",
        "--title",
        "Legacy Unbound Page",
      ],
      {
        cwd: workDir,
        baseUrl,
        token: cliToken,
        extraEnv: {
          HTML_PREVIEW_DAEMON_SOCK: join(workDir, "nonexistent-daemon.sock"),
        },
      },
    );
    assert.equal(uploadedUnbound.binding ?? null, null);
    const unboundDocId = uploadedUnbound.id;

    // Verify previewed HTML injects ⌘I / Ctrl+I (`html-preview:toggle-interact`) bridge
    const previewHtml = await (
      await fetch(uploadedUnbound.url, {
        headers: { Cookie: sessionCookie },
      })
    ).text();
    assert.match(
      previewHtml,
      /html-preview:toggle-interact/,
      `${runtimeLabel}: preview HTML must inject ⌘I / Ctrl+I toggle-interact bridge`,
    );

    const int4Res = await fetch(`${baseUrl}/api/archives/${unboundDocId}/interactions`, {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: baseUrl,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: `${runtimeLabel}-scen4-turn1`,
        prompt: "Comment directly on historical unbound page without binding first.",
      }),
    });
    assert.equal(int4Res.status, 201, `${runtimeLabel}: unbound page comment must succeed with 201`);
    const int4 = (await int4Res.json()).interaction;
    assert.equal(int4.targetAdapterId, "auto");

    await waitFor(
      () =>
        browserEvents.some(
          e =>
            e.type === "interaction" &&
            e.interaction?.id === int4.id &&
            e.interaction?.status === "replied",
        ),
      `${runtimeLabel} Scenario 4 Turn 1 unbound adhoc 'replied'`,
    );

    await waitFor(async () => {
      const st = await (
        await fetch(`${baseUrl}/api/archives/${unboundDocId}/interactions`, {
          headers: { Cookie: sessionCookie },
        })
      ).json();
      return st.bindings?.some(b => b.hostId === "hst_box02" && b.adapterId === "claude");
    }, `${runtimeLabel} Scenario 4 auto-persisted discoveredBinding`);

    const int5Res = await fetch(`${baseUrl}/api/archives/${unboundDocId}/interactions`, {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: baseUrl,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: `${runtimeLabel}-scen4-turn2`,
        parentId: int4.id,
        prompt: "Follow-up turn should auto-resume the discovered session.",
      }),
    });
    assert.equal(int5Res.status, 201);
    const int5 = (await int5Res.json()).interaction;
    assert.equal(int5.targetHostId, "hst_box02");

    await waitFor(
      () =>
        browserEvents.some(
          e =>
            e.type === "interaction" &&
            e.interaction?.id === int5.id &&
            e.interaction?.status === "replied" &&
            /Resumed claude \(claude-adhoc-demo-99\)/.test(e.interaction?.replyText || ""),
        ),
      `${runtimeLabel} Scenario 4 Turn 2 auto-resumed 'replied'`,
    );

    return {
      runtime: runtimeLabel,
      multiHostAntiSteal: `PASS (Mac=${macDeliveredCount}, BoxSteal=0)`,
      directResumeAndV2: `PASS (${int2Final.effectiveAdapterId}, v${int2Final.resultVersion})`,
      sleepQueueAndWakePush: `PASS (1->${scen3Pushes[0].path})`,
      explicitHandoff: "PASS (Mac->grok-bot-box v3)",
      zeroManualBind: "PASS (auto->hst_box02/claude->resume)",
    };
  } finally {
    if (browserWs) {
      try {
        browserWs.close();
      } catch {}
    }
    await macDaemon.stop().catch(() => {});
    await boxDaemon.stop().catch(() => {});
  }
}

async function killChildProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(r => child.once("exit", () => r(undefined)));
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  const killTimer = setTimeout(() => {
    if (child.exitCode === null) {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    }
  }, 3000);
  killTimer.unref?.();
  await exited;
  clearTimeout(killTimer);
}

async function main() {
  const tmpRoot = mkdtempSync(join(tmpdir(), "html-preview-e2e-demo-"));
  let s3Mock = null;
  let pushReceiver = null;
  let nodeServer = null;
  let wranglerProc = null;

  try {
    console.log("==> Booting isolated local-s3-mock & local Web Push receiver on 127.0.0.1...");
    s3Mock = await startLocalS3Mock({ host: "127.0.0.1", port: 0 });
    pushReceiver = await startLocalPushReceiver();
    const modules = await buildRuntimeModules(tmpRoot);

    const summaryRows = [];

    // -------------------------------------------------------------------------
    // PART 1: Self-Hosted Node Runtime (startNodePreviewServer + ws + 2x HostDaemon)
    // -------------------------------------------------------------------------
    console.log(
      "\n==> [Part 1/2] Exercising Self-Hosted Node Runtime (node:sqlite + ws + Mac & Box HostDaemons)...",
    );
    const nodeWorkDir = join(tmpRoot, "part1-node");
    mkdirSync(nodeWorkDir, { recursive: true });
    const nodeStore = new modules.S3Store({
      S3_ENDPOINT: s3Mock.url,
      S3_BUCKET: "demo-node-bucket",
      S3_REGION: "auto",
      S3_ACCESS_KEY_ID: "demo-local-ak",
      S3_SECRET_ACCESS_KEY: "demo-local-sk",
    });

    nodeServer = await modules.startNodePreviewServer({
      ALLOW_DEV_LOGIN: "1",
      ADMIN_GITHUB_LOGIN: "alice",
      host: "127.0.0.1",
      port: 0,
      databasePath: join(nodeWorkDir, "node.sqlite"),
      store: nodeStore,
      VAPID_PUBLIC_KEY:
        "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
    });

    const nodeResult = await runScenarioSuite({
      runtimeLabel: "Self-Hosted Node",
      baseUrl: nodeServer.url,
      workDir: nodeWorkDir,
      pushReceiver,
      modules,
      onVerifySocketCounts: async (userId, expected) => {
        await waitFor(() => {
          const counts = nodeServer.getActiveSocketCounts(userId);
          return counts.browser === expected.browser && counts.daemon === expected.daemon;
        }, `Node socket counts browser=${expected.browser}, daemon=${expected.daemon}`);
      },
    });
    summaryRows.push(nodeResult);
    await nodeServer.close();
    nodeServer = null;
    console.log("    [PASS] Self-Hosted Node Runtime verified end-to-end.");

    // -------------------------------------------------------------------------
    // PART 2: Cloudflare Worker Runtime (wrangler dev --local + D1 + HtmlPreviewEvents DO)
    // -------------------------------------------------------------------------
    console.log(
      "\n==> [Part 2/2] Exercising Cloudflare Worker Runtime (wrangler dev --local + D1 + HtmlPreviewEvents DO)...",
    );
    const cfWorkDir = join(tmpRoot, "part2-cf");
    const cfPersistDir = join(cfWorkDir, "persist");
    const workerPort = await getFreePort("127.0.0.1");
    const workerBaseUrl = `http://127.0.0.1:${workerPort}`;
    const wranglerTomlPath = join(cfWorkDir, "wrangler.demo.toml");

    const wranglerToml = [
      `name = "html-preview"`,
      `main = ${JSON.stringify(WORKER_MAIN)}`,
      `compatibility_date = "2026-11-04"`,
      `workers_dev = false`,
      `preview_urls = false`,
      ``,
      `[vars]`,
      `PUBLIC_BASE_URL = ${JSON.stringify(workerBaseUrl)}`,
      `S3_ENDPOINT = ${JSON.stringify(s3Mock.url)}`,
      `S3_BUCKET = "demo-cf-bucket"`,
      `S3_REGION = "auto"`,
      `S3_ACCESS_KEY_ID = "demo-local-ak"`,
      `S3_SECRET_ACCESS_KEY = "demo-local-sk"`,
      `ADMIN_GITHUB_LOGIN = "alice"`,
      `ALLOW_DEV_LOGIN = "1"`,
      `VAPID_PUBLIC_KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U"`,
      ``,
      `[[d1_databases]]`,
      `binding = "DB"`,
      `database_name = "html-preview"`,
      `database_id = "00000000-0000-4000-8000-000000000001"`,
      `migrations_dir = ${JSON.stringify(MIGRATIONS_DIR)}`,
      ``,
      `[[durable_objects.bindings]]`,
      `name = "EVENTS"`,
      `class_name = "HtmlPreviewEvents"`,
      ``,
      `[[migrations]]`,
      `tag = "html-preview-events-v1"`,
      `new_sqlite_classes = ["HtmlPreviewEvents"]`,
      ``,
    ].join("\n");

    mkdirSync(cfPersistDir, { recursive: true });
    writeFileSync(wranglerTomlPath, wranglerToml, "utf8");

    const wranglerEnv = {
      ...process.env,
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
      NO_D1_WARNING: "true",
    };

    await runExecFile(
      "npx",
      [
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "html-preview",
        "--local",
        "--config",
        wranglerTomlPath,
        "--persist-to",
        cfPersistDir,
      ],
      { cwd: REPO_ROOT, env: wranglerEnv, timeoutMs: 60000 },
    );

    let wranglerLogs = "";
    wranglerProc = spawn(
      "npx",
      [
        "wrangler",
        "dev",
        "--local",
        "--config",
        wranglerTomlPath,
        "--persist-to",
        cfPersistDir,
        "--port",
        String(workerPort),
        "--ip",
        "127.0.0.1",
        "--show-interactive-dev-session=false",
      ],
      {
        cwd: REPO_ROOT,
        env: wranglerEnv,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    wranglerProc.stdout?.on("data", chunk => {
      wranglerLogs += String(chunk);
    });
    wranglerProc.stderr?.on("data", chunk => {
      wranglerLogs += String(chunk);
    });

    await waitFor(
      async () => {
        if (wranglerProc.exitCode !== null) {
          throw new Error(
            `wrangler dev exited prematurely (code ${wranglerProc.exitCode}):\n${wranglerLogs}`,
          );
        }
        try {
          const res = await fetch(`${workerBaseUrl}/manifest.webmanifest`);
          return res.status === 200;
        } catch {
          return false;
        }
      },
      "wrangler dev --local HTTP readiness",
      30000,
      150,
    );

    const cfResult = await runScenarioSuite({
      runtimeLabel: "Cloudflare Worker (local)",
      baseUrl: workerBaseUrl,
      workDir: cfWorkDir,
      pushReceiver,
      modules,
    });
    summaryRows.push(cfResult);
    console.log("    [PASS] Cloudflare Worker Runtime verified end-to-end.");

    console.log("\n================================================================================");
    console.log("  DUAL-RUNTIME PERSISTENT DAEMON E2E DEMO — PASS SUMMARY");
    console.log("================================================================================");
    console.table(summaryRows);
    console.log(
      `Isolated S3 objects stored strictly in-memory (${s3Mock.objects.size} objects, 0 remote R2/D1 calls).\n`,
    );
  } finally {
    if (wranglerProc) {
      await killChildProcessTree(wranglerProc).catch(() => {});
    }
    if (nodeServer) {
      await nodeServer.close().catch(() => {});
    }
    if (pushReceiver) {
      await pushReceiver.close().catch(() => {});
    }
    if (s3Mock) {
      await s3Mock.close().catch(() => {});
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

await main();
