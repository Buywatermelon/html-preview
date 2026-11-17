import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { AcpSessionManager, SessionRingBuffer } from "../src/daemon/acp-sessions";
import { runWsStdioBridge } from "../src/daemon/index";
import {
  SessionFileTail,
  acquireCooperativeSessionLock,
  inspectCooperativeLock,
  inspectSessionOwner,
  terminalOwnsSession,
  transcriptUpdates,
} from "../src/daemon/session-files";
import { relayRealtimeSocketFrame, type RelayPeer } from "../src/ws-relay";
import { applyStream, emptyTranscript } from "../frontend/src/acp-transcript";
import type { AcpServerFrame } from "../src/acp-types";

const roots: string[] = [], managers: AcpSessionManager[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) {
    try { c.kill("SIGKILL"); } catch {}
  }
  await Promise.all(managers.splice(0).map(m => m.close()));
  roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true }));
  vi.unstubAllGlobals();
});
const temp = () => { const p = mkdtempSync(join(tmpdir(), "hp-acp-")); roots.push(p); return p; };
const waitFor = async (fn: () => unknown, maxTicks = 250) => {
  for (let n = 0; n < maxTicks; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 15)); }
  throw new Error("Timed out");
};
const fixture = resolve("test/fixtures/acp-agent.mjs");
chmodSync(fixture, 0o755);
function manager(extra: Partial<ConstructorParameters<typeof AcpSessionManager>[0]> = {}) {
  const frames: AcpServerFrame[] = [];
  const m = new AcpSessionManager({
    emit: f => frames.push(f),
    env: { ...process.env, CODEX_ACP_BIN: fixture, CLAUDE_ACP_BIN: fixture, AGY_BIN: fixture, GROK_BIN: fixture },
    ...extra,
  });
  managers.push(m);
  return { m, frames };
}
const open = (m: AcpSessionManager, cwd: string, readOnly = false) =>
  m.open({ sessionKey: "codex:test-session", adapterId: "codex", sessionId: readOnly ? undefined : "test-session", cwd, readOnly, clientId: "browser" });

function spawnLockHolder(lockFile: string, ownerJson: Record<string, unknown>): Promise<{ child: ChildProcess; pid: number }> {
  return new Promise((resolveHolder, rejectHolder) => {
    const py = [
      "import fcntl, json, os, signal, sys, time",
      "lock_path = sys.argv[1]",
      "meta = json.loads(sys.argv[2])",
      "os.makedirs(os.path.dirname(lock_path), exist_ok=True)",
      "fd = open(lock_path, 'a+', encoding='utf-8')",
      "fcntl.flock(fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)",
      "meta['pid'] = os.getpid()",
      "open(lock_path[:-5] + '.owner.json', 'w', encoding='utf-8').write(json.dumps(meta))",
      "signal.signal(signal.SIGINT, lambda *_: sys.exit(0))",
      "sys.stdout.write('LOCKED:' + str(os.getpid()) + '\\n')",
      "sys.stdout.flush()",
      "while True:\n    time.sleep(0.05)",
    ].join("\n");
    const child = spawn("python3", ["-c", py, lockFile, JSON.stringify(ownerJson)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let out = "";
    child.stdout!.on("data", chunk => {
      out += chunk.toString("utf-8");
      const m = out.match(/LOCKED:(\d+)/);
      if (m) resolveHolder({ child, pid: Number(m[1]) });
    });
    child.once("error", rejectHolder);
    child.once("exit", code => {
      if (!out.includes("LOCKED:")) rejectHolder(new Error(`Lock holder exited early: ${code}`));
    });
  });
}

describe("ACP session lifecycle over real stdio JSON-RPC", () => {
  it("replays complete history, streams tools and answers, and recovers precisely after seq", async () => {
    const { m, frames } = manager(); await open(m, temp());
    expect(frames.filter(f => f.type === "acp_stream_event").flatMap(f => f.events).map(e => e.update.sessionUpdate)).toContain("tool_call_update");
    const result = await m.prompt("codex:test-session", "large");
    expect(result.replyText).toBe("stream agent answer");
    let transcript = emptyTranscript();
    for (const f of frames) if (f.type === "acp_stream_event") {
      expect(Buffer.byteLength(JSON.stringify(f))).toBeLessThan(65536); transcript = applyStream(transcript, f);
    }
    expect(transcript.rows.find(r => r.update.toolCallId === "large")?.update.rawOutput).toBe("汉字🌏".repeat(14000));
    const before = transcript.seq; const epoch = transcript.epoch;
    await m.prompt("codex:test-session", "second");
    const start = frames.length; await m.sync("codex:test-session", before, epoch, "mobile");
    const replay = frames.slice(start).filter(f => f.type === "acp_stream_event");
    expect(replay.length).toBeGreaterThan(0);
    expect(replay.every(f => f.targetClientId === "mobile" && f.events.every(e => e.seq > before))).toBe(true);
  });
  it("suspends permissions, replays pending requests, validates responses, and cancels", async () => {
    const { m, frames } = manager(); await open(m, temp());
    const running = m.prompt("codex:test-session", "permission");
    await waitFor(() => frames.some(f => f.type === "acp_permission_request"));
    const permission = frames.find(f => f.type === "acp_permission_request")!;
    if (permission.type !== "acp_permission_request") throw new Error();
    await m.sync("codex:test-session", 0, undefined, "mobile");
    expect(frames.some(f => f.type === "acp_permission_request" && f.targetClientId === "mobile")).toBe(true);
    expect(() => m.respond("codex:test-session", permission.permissionId, { outcome: "selected", optionId: "forged" })).toThrow();
    m.respond("codex:test-session", permission.permissionId, { outcome: "selected", optionId: "reject" });
    expect((await running).replyText).toContain("reject");
    const waiting = m.prompt("codex:test-session", "wait");
    await waitFor(() => m.getState("codex:test-session")?.status === "busy");
    await expect(m.prompt("codex:test-session", "duplicate")).rejects.toThrow("already working");
    await m.cancel("codex:test-session"); await waiting;
    expect(m.getState("codex:test-session")?.status).toBe("ready");
  });
  it("locks temporary sessions to read-only, denies all permissions and mode escalation", async () => {
    const { m, frames } = manager(); await open(m, temp(), true);
    await expect(m.setMode("codex:test-session", "agent")).rejects.toThrow();
    expect((await m.prompt("codex:test-session", "hello")).replyText).toBe("stream read-only answer");
    expect((await m.prompt("codex:test-session", "permission")).replyText).toContain("cancelled");
    expect(frames.some(f => f.type === "acp_permission_request")).toBe(false);
  });
  it("spectates terminal history and tails output, then takes over after exit", async () => {
    const root = temp(); const dir = join(root, ".codex/sessions/2026/11/14"); mkdirSync(dir, { recursive: true });
    const file = join(dir, "rollout-test-session.jsonl");
    const row = (text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ text }] } }) + "\n";
    writeFileSync(file, row("terminal history")); let busy = true;
    const { m, frames } = manager({ homeDir: root, isTerminalBusy: () => busy, tickMs: 20 });
    await open(m, root); expect(m.getState("codex:test-session")?.status).toBe("spectating");
    await expect(m.prompt("codex:test-session", "blocked")).rejects.toThrow("终端正在使用");
    appendFileSync(file, row("live terminal output"));
    await waitFor(() => frames.some(f => f.type === "acp_stream_event" && JSON.stringify(f).includes("live terminal output")));
    busy = false; await waitFor(() => m.getState("codex:test-session")?.status === "ready");
    expect((await m.prompt("codex:test-session", "take over")).replyText).toContain("answer");
  });
  it("reclaims idle processes only after subscriptions expire/unsubscribe", async () => {
    const { m } = manager({ idleMs: 10, tickMs: 15 }); await open(m, temp());
    await new Promise(r => setTimeout(r, 40)); expect(m.has("codex:test-session")).toBe(true);
    m.unsubscribe("codex:test-session", "browser"); await waitFor(() => !m.has("codex:test-session"));
  });

  it("performs one-click gentle SIGINT takeover when verified terminal owner is idle", async () => {
    const root = temp();
    const lockDir = join(root, "locks");
    const agyDir = join(root, ".gemini/antigravity-cli/brain/test-session/.system_generated/logs");
    mkdirSync(agyDir, { recursive: true });
    writeFileSync(
      join(agyDir, "transcript.jsonl"),
      JSON.stringify({ step_index: 0, type: "PLANNER_RESPONSE", status: "DONE", content: "idle turn done" }) + "\n",
    );
    const { child } = await spawnLockHolder(join(lockDir, "agy__test-session.lock"), {
      adapterId: "agy",
      sessionId: "test-session",
    });

    const availableKeys: string[] = [];
    const { m } = manager({
      homeDir: root,
      lockDir,
      tickMs: 25,
      onSessionAvailable: key => availableKeys.push(key),
    });

    await m.open({
      sessionKey: "agy:test-session",
      adapterId: "agy",
      sessionId: "test-session",
      cwd: root,
      readOnly: false,
      clientId: "browser",
    });
    expect(m.getState("agy:test-session")?.status).toBe("spectating");
    expect(m.getState("agy:test-session")?.canTakeover).toBe(true);
    expect(m.getState("agy:test-session")?.terminalBusy).toBe(false);

    await m.requestTakeover("agy:test-session");
    await waitFor(() => m.getState("agy:test-session")?.status === "ready");
    expect(child.exitCode).not.toBeNull();
    expect(availableKeys).toContain("agy:test-session");
    expect((await m.prompt("agy:test-session", "after takeover")).replyText).toContain("answer");
  });

  it("waits for busy terminal turn to finish before sending gentle SIGINT (takeoverPending)", async () => {
    const root = temp();
    const lockDir = join(root, "locks");
    const agyDir = join(root, ".gemini/antigravity-cli/brain/test-session/.system_generated/logs");
    mkdirSync(agyDir, { recursive: true });
    const transcriptFile = join(agyDir, "transcript.jsonl");
    writeFileSync(
      transcriptFile,
      JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: "working in terminal" }) + "\n",
    );
    const { child } = await spawnLockHolder(join(lockDir, "agy__test-session.lock"), {
      adapterId: "agy",
      sessionId: "test-session",
    });

    const { m } = manager({ homeDir: root, lockDir, tickMs: 25 });
    await m.open({
      sessionKey: "agy:test-session",
      adapterId: "agy",
      sessionId: "test-session",
      cwd: root,
      readOnly: false,
      clientId: "browser",
    });
    expect(m.getState("agy:test-session")?.status).toBe("spectating");
    expect(m.getState("agy:test-session")?.terminalBusy).toBe(true);

    await m.requestTakeover("agy:test-session");
    // Must NOT kill busy terminal mid-turn; schedules takeoverPending instead
    await new Promise(r => setTimeout(r, 60));
    expect(child.exitCode).toBeNull();
    expect(m.getState("agy:test-session")?.status).toBe("spectating");
    expect(m.getState("agy:test-session")?.takeoverPending).toBe(true);

    // Terminal finishes current turn -> sweep detects idle -> gentle SIGINT -> cold load -> ready
    appendFileSync(
      transcriptFile,
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", content: "turn finished" }) + "\n",
    );
    await waitFor(() => m.getState("agy:test-session")?.status === "ready");
    expect(child.exitCode).not.toBeNull();
    expect(m.getState("agy:test-session")?.takeoverPending).toBeFalsy();
  });

  it("recycles warm agy ACP process and cold-loads instead of warm session/resume when transcript changes externally", async () => {
    const root = temp();
    const rpcLog = join(root, "rpc.jsonl");
    const agyDir = join(root, ".gemini/antigravity-cli/brain/test-session/.system_generated/logs");
    mkdirSync(agyDir, { recursive: true });
    const transcriptFile = join(agyDir, "transcript.jsonl");
    writeFileSync(
      transcriptFile,
      JSON.stringify({ step_index: 0, type: "PLANNER_RESPONSE", status: "DONE", content: "initial" }) + "\n",
    );

    const { m } = manager({
      homeDir: root,
      env: { ...process.env, AGY_BIN: fixture, ACP_LOG_FILE: rpcLog },
    });
    await m.open({
      sessionKey: "agy:test-session",
      adapterId: "agy",
      sessionId: "test-session",
      cwd: root,
      readOnly: false,
      clientId: "browser",
    });

    // External writer appends a completed turn directly to transcript.jsonl
    appendFileSync(
      transcriptFile,
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", content: "external turn" }) + "\n",
    );

    const res = await m.prompt("agy:test-session", "web follow-up");
    expect(res.replyText).toContain("answer");

    const entries = readFileSync(rpcLog, "utf-8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line) as { pid: number; method: string });
    expect(entries.some(e => e.method === "session/resume")).toBe(false);
    const loadPids = entries.filter(e => e.method === "session/load").map(e => e.pid);
    expect(loadPids.length).toBe(2);
    expect(loadPids[1]).not.toBe(loadPids[0]);
  });

  it("supports shared executor concurrent prompts without auto-cancel and detaches on idle without session/close", async () => {
    const root = temp();
    const rpcLog = join(root, "shared-rpc.jsonl");
    const leaderSock = join(root, "leader.sock");
    writeFileSync(leaderSock, "");

    const { m } = manager({
      homeDir: root,
      idleMs: 15,
      tickMs: 15,
      env: { ...process.env, GROK_BIN: fixture, ACP_LOG_FILE: rpcLog },
      inspectOwner: () => ({
        ownedByExternal: false,
        uncertain: false,
        busy: false,
        canTakeover: false,
        sharedEndpoint: { kind: "grok-leader", socketPath: leaderSock },
      }),
    });

    await m.open({
      sessionKey: "grok:test-session",
      adapterId: "grok",
      sessionId: "test-session",
      cwd: root,
      readOnly: false,
      clientId: "browser",
    });
    expect(m.getState("grok:test-session")?.shared).toBe(true);

    // Start first turn that blocks ("wait"), then send a second concurrent prompt while busy
    const firstTurn = m.prompt("grok:test-session", "wait");
    await waitFor(() => m.getState("grok:test-session")?.status === "busy");
    const secondTurn = await m.prompt("grok:test-session", "concurrent-message");
    expect(secondTurn.replyText).toContain("answer");
    expect(m.getState("grok:test-session")?.status).toBe("busy");

    await m.cancel("grok:test-session");
    await firstTurn;
    expect(m.getState("grok:test-session")?.status).toBe("ready");

    // Unsubscribe and let idle sweep detach: must NEVER send session/close to shared leader!
    m.unsubscribe("grok:test-session", "browser");
    await waitFor(() => !m.has("grok:test-session"));

    const entries = readFileSync(rpcLog, "utf-8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line) as { method: string; args: string[] });
    expect(entries[0].args).toEqual(["agent", "--leader", "stdio", "--leader-socket", leaderSock]);
    expect(entries.some(e => e.method === "session/close")).toBe(false);
  });

  it("bridges JSON lines to WebSocket-over-Unix frames via runWsStdioBridge", async () => {
    const root = temp();
    const sockPath = join(root, "codex-app.sock");
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    wss.on("connection", ws => {
      ws.on("message", msg => {
        const parsed = JSON.parse(msg.toString("utf-8")) as { id: number; ping: string };
        ws.send(JSON.stringify({ id: parsed.id, pong: parsed.ping }));
      });
    });
    await new Promise<void>(r => httpServer.listen(sockPath, r));

    const bridgeChild = spawn(process.execPath, [resolve("dist/daemon.mjs"), "ws-stdio-bridge", "app-server"], {
      env: { ...process.env, HTML_PREVIEW_CODEX_UNIX_SOCKET: sockPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(bridgeChild);

    try {
      const received: string[] = [];
      bridgeChild.stdout!.on("data", chunk => received.push(chunk.toString("utf-8")));
      bridgeChild.stdin!.write('{"id":1,"ping":"codex-shared"}\n');
      await waitFor(() => received.join("").includes('"pong":"codex-shared"'));
      bridgeChild.stdin!.end();
      await waitFor(() => bridgeChild.exitCode !== null);
    } finally {
      wss.close();
      await new Promise<void>(r => httpServer.close(() => r()));
    }
  });
});

it("bounds replay memory by count and bytes while keeping seq monotonic", () => {
  const ring = new SessionRingBuffer(2, 1000);
  const u = { sessionUpdate: "agent_message_chunk", content: { text: "x" } };
  ring.append(u, "live"); ring.append(u, "live"); ring.append(u, "live");
  expect(ring.after(0)).toBeNull(); expect(ring.after(1)?.map(e => e.seq)).toEqual([2, 3]);
  ring.clear(); expect(ring.append(u, "live").seq).toBe(4);
  expect(new SessionRingBuffer(2000, 20).append(u, "live").seq).toBe(1);
});
it("tails partial UTF-8 JSONL safely and restarts on truncation", () => {
  const root = temp(), file = join(root, "transcript.jsonl"); const row = Buffer.from(JSON.stringify({ text: "汉🌏字" }) + "\n");
  writeFileSync(file, row.subarray(0, 12)); const rows: unknown[] = []; const reset = vi.fn();
  const tail = new SessionFileTail(file, r => rows.push(r), reset); tail.read(); expect(rows).toEqual([]);
  appendFileSync(file, row.subarray(12)); tail.read(); expect(rows).toEqual([{ text: "汉🌏字" }]);
  writeFileSync(file, "{}\n"); tail.read(); expect(reset).toHaveBeenCalledOnce(); expect(rows.at(-1)).toEqual({}); tail.close();
});
it("checks Claude live PIDs, coordinates OS flock locks, and never matches agy/grok by cwd alone", async () => {
  const root = temp(), dir = join(root, ".claude/sessions"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ sessionId: "s", pid: process.pid }));
  expect(terminalOwnsSession("claude", "s", root, new Set(), root)).toBe(true);
  expect(terminalOwnsSession("claude", "s", root, new Set([process.pid]), root)).toBe(false);
  expect(transcriptUpdates("claude", { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Edit", input: { path: "x", new: "all" } }] } })[0].rawInput).toEqual({ path: "x", new: "all" });
  const raw = { sessionUpdate: "tool_call_update", toolCallId: "g", content: [{ type: "diff", newText: "full" }] };
  expect(transcriptUpdates("grok", { params: { update: raw } })).toEqual([raw]);

  // Unowned agy session in same cwd must NOT be falsely flagged as owned by current process
  const agyOwn = inspectSessionOwner("agy", "unrelated-session-id", process.cwd(), new Set(), root, join(root, "locks"));
  expect(agyOwn.ownedByExternal).toBe(false);

  // Cooperative OS flock lock held by lockHandle.pid is ignored when ownPids includes lockHandle.pid, and detected when ownPids is empty
  const lockDir = join(root, "locks");
  const handle = await acquireCooperativeSessionLock(lockDir, "agy", "locked-sess");
  expect(handle).not.toBeNull();
  expect(await acquireCooperativeSessionLock(lockDir, "agy", "locked-sess")).toBeNull();
  expect(inspectCooperativeLock("agy", "locked-sess", root, lockDir, new Set([handle!.pid!]), root)).toBeNull();
  expect(inspectCooperativeLock("agy", "locked-sess", root, lockDir, new Set(), root)?.ownedByExternal).toBe(true);
  handle?.release();
  await waitFor(() => inspectCooperativeLock("agy", "locked-sess", root, lockDir, new Set(), root) === null);
});

describe("shared zero-storage relay", () => {
  function peers() {
    const browser = { role: "browser", clientId: "b", send: vi.fn() } satisfies RelayPeer;
    const daemon = { role: "daemon", hostId: "h", send: vi.fn() } satisfies RelayPeer;
    const other = { role: "daemon", hostId: "other", send: vi.fn() } satisfies RelayPeer;
    return { browser, daemon, other, all: () => [browser, daemon, other] };
  }
  it("stamps real host/client identities, respects direction and sends only to the selected daemon", () => {
    const { browser, daemon, other, all } = peers();
    expect(relayRealtimeSocketFrame(browser, JSON.stringify({ type: "acp_client_cmd", action: "takeover", targetHostId: "h", clientId: "forged" }), all)).toBe(true);
    expect(JSON.parse(daemon.send.mock.calls[0][0]).clientId).toBe("b"); expect(other.send).not.toHaveBeenCalled();
    relayRealtimeSocketFrame(daemon, JSON.stringify({ type: "acp_session_state", sessionKey: "s", status: "ready", hostId: "forged" }), all);
    expect(JSON.parse(browser.send.mock.calls[0][0]).hostId).toBe("h");
    expect(relayRealtimeSocketFrame(browser, JSON.stringify({ type: "acp_session_state", sessionKey: "s", status: "ready" }), all)).toBe(false);
  });
  it("rejects malformed/oversized frames and returns HOST_OFFLINE", () => {
    const { browser, daemon, all } = peers();
    expect(relayRealtimeSocketFrame(daemon, "{", all)).toBe(false);
    expect(relayRealtimeSocketFrame(daemon, JSON.stringify({ type: "acp_stream_event", sessionKey: "s", epoch: "e", events: [{ seq: -1 }] }), all)).toBe(false);
    expect(relayRealtimeSocketFrame(browser, "汉".repeat(30000), all)).toBe(false);
    relayRealtimeSocketFrame(browser, JSON.stringify({ type: "acp_client_cmd", action: "open_session", targetHostId: "offline" }), all);
    expect(JSON.parse(browser.send.mock.calls[0][0]).code).toBe("HOST_OFFLINE");
  });
});
