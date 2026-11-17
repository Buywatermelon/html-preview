import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createApp } from "../src/app";
import { Auth, hash, requestCredential, type AuthConfig } from "../src/auth";
import { HtmlPreviewEvents } from "../src/events";
import { applyMigrations, sqliteDatabase } from "../src/node-db";
import { startNodePreviewServer } from "../src/node-server";
import { S3Store } from "../src/storage";
import type { PushDispatcher, WebPushNotificationPayload } from "../src/pwa";
import type {
  InteractionEnvelope,
  InteractionRecord,
  PushSubscriptionRecord,
  RealtimeEvent,
} from "../src/interact-types";
import {
  AgyAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
} from "../src/daemon/adapters/acp-agent";
import { createDefaultRegistry } from "../src/daemon/registry";
import { encodeOpaqueBinding } from "../src/daemon/opaque-binding";
import { DaemonServerConnection } from "../src/daemon/transport";
import { startLocalS3Mock } from "../scripts/local-s3-mock.mjs";

const BASE_URL = "https://preview.example";
const DEFAULT_AUTH_CONFIG: AuthConfig = {
  PUBLIC_BASE_URL: BASE_URL,
  GITHUB_CLIENT_ID: "test-client",
  GITHUB_CLIENT_SECRET: "test-secret",
  ADMIN_GITHUB_LOGIN: "alice",
  ALLOW_DEV_LOGIN: "1",
};

function createMemoryStore(objects = new Map<string, { data: Uint8Array; type: string }>()) {
  return {
    objects,
    async put(key: string, data: Uint8Array, type = "application/octet-stream") {
      objects.set(key, { data: data.slice(), type });
    },
    async get(key: string) {
      const entry = objects.get(key);
      return entry
        ? new Response(entry.data.slice(), {
            headers: {
              "Content-Type": entry.type,
              "Content-Length": String(entry.data.byteLength),
            },
          })
        : null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
}

interface MockWorkerSocket {
  attachment: unknown;
  sent: string[];
  closed: { code?: number; reason?: string } | null;
  serializeAttachment(val: unknown): void;
  deserializeAttachment(): unknown;
  send(msg: string): void;
  close(code?: number, reason?: string): void;
}

function createMockWebSocketPair(): [MockWorkerSocket, MockWorkerSocket] {
  const makeSide = (): MockWorkerSocket => {
    const sock: MockWorkerSocket = {
      attachment: null,
      sent: [],
      closed: null,
      serializeAttachment(val: unknown) {
        sock.attachment = structuredClone(val);
      },
      deserializeAttachment() {
        return sock.attachment;
      },
      send(msg: string) {
        if (sock.closed) throw new Error("Socket closed");
        sock.sent.push(String(msg));
      },
      close(code?: number, reason?: string) {
        sock.closed = { code, reason };
      },
    };
    return sock;
  };
  const client = makeSide();
  const server = makeSide();
  server.send = (msg: string) => {
    if (server.closed) throw new Error("Socket closed");
    server.sent.push(String(msg));
    client.sent.push(String(msg));
  };
  const origServerClose = server.close;
  server.close = (code?: number, reason?: string) => {
    origServerClose(code, reason);
    client.closed = { code, reason };
  };
  return [client, server];
}

function installCloudflareWorkerGlobals() {
  const OrigResponse = globalThis.Response;
  const PatchedResponse = new Proxy(OrigResponse, {
    construct(target, args, newTarget) {
      const [body, init] = args as [BodyInit | null | undefined, (ResponseInit & { webSocket?: unknown }) | undefined];
      if (init && init.status === 101) {
        const rest: ResponseInit = { ...init, status: 200 };
        const ws = init.webSocket;
        delete (rest as { webSocket?: unknown }).webSocket;
        const res = Reflect.construct(target, [body, rest], newTarget);
        Object.defineProperty(res, "status", { value: 101 });
        Object.defineProperty(res, "webSocket", { value: ws });
        return res;
      }
      return Reflect.construct(target, args, newTarget);
    },
  });
  vi.stubGlobal("Response", PatchedResponse);
  vi.stubGlobal("WebSocketRequestResponsePair", class {});
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0: MockWorkerSocket;
      1: MockWorkerSocket;
      constructor() {
        const [c, s] = createMockWebSocketPair();
        this[0] = c;
        this[1] = s;
      }
    },
  );
}

function createWorkerRuntimeHarness(overrides: Partial<AuthConfig> = {}) {
  installCloudflareWorkerGlobals();

  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const db = sqliteDatabase(sqlite);
  const store = createMemoryStore();
  const cfg: AuthConfig = { ...DEFAULT_AUTH_CONFIG, ...overrides };
  const pending: Promise<unknown>[] = [];
  const pushCalls: Array<{
    subscriptions: PushSubscriptionRecord[];
    payload: WebPushNotificationPayload;
  }> = [];

  const d1Binding = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        all: async () => ({ results: sqlite.prepare(sql).all(...(values as any[])) }),
        run: async () => {
          sqlite.prepare(sql).run(...(values as any[]));
          return { success: true };
        },
      }),
    }),
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      for (const s of stmts) await s.run();
      return [];
    },
  };

  const doInstances = new Map<
    string,
    {
      sockets: Set<MockWorkerSocket>;
      doInstance: HtmlPreviewEvents;
    }
  >();

  function getEventsDo(userId: string) {
    let entry = doInstances.get(userId);
    if (!entry) {
      const sockets = new Set<MockWorkerSocket>();
      const state = {
        setWebSocketAutoResponse() {},
        acceptWebSocket(ws: unknown) {
          sockets.add(ws as MockWorkerSocket);
        },
        getWebSockets() {
          return [...sockets].filter(s => !s.closed);
        },
      } as unknown as DurableObjectState;
      const doInstance = new HtmlPreviewEvents(state, {
        DB: d1Binding as unknown as D1Database,
      });
      entry = { sockets, doInstance };
      doInstances.set(userId, entry);
    }
    return entry;
  }

  const pushDispatcher: PushDispatcher = async (subscriptions, payload) => {
    pushCalls.push({ subscriptions, payload });
  };

  const lastNotifyBrowserCounts: Record<string, number>[] = [];

  const app = createApp({
    ...cfg,
    db,
    store,
    VAPID_PUBLIC_KEY: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
    pushDispatcher,
    defer(promise) {
      pending.push(promise);
    },
    async events(request, user) {
      const headers = new Headers(request.headers);
      const u = new URL(request.url);
      const rawRole = u.searchParams.get("role");
      const role = rawRole === "daemon" ? "daemon" : "browser";
      headers.set("X-Html-Preview-Credential", JSON.stringify(await requestCredential(request)));
      headers.set("X-Html-Preview-Role", role);
      const hostId = u.searchParams.get("host_id");
      const hostName = u.searchParams.get("host_name");
      if (hostId) headers.set("X-Html-Preview-Host-Id", hostId);
      if (hostName) headers.set("X-Html-Preview-Host-Name", hostName);
      return getEventsDo(user.id).doInstance.fetch(new Request(request, { headers }));
    },
    async disconnect(userId) {
      await getEventsDo(userId).doInstance.fetch(
        new Request("https://html-preview/revalidate", { method: "POST" }),
      );
    },
    async notify(users, event) {
      const entries = await Promise.all(
        users.map(async id => {
          const res = await getEventsDo(id).doInstance.fetch(
            new Request("https://html-preview/changed", {
              method: "POST",
              body: event ? JSON.stringify(event) : undefined,
            }),
          );
          const count = Number(res.headers.get("X-Html-Preview-Active-Browsers") || "0") || 0;
          return [id, count] as const;
        }),
      );
      const activeBrowserCount = Object.fromEntries(entries);
      lastNotifyBrowserCounts.push(activeBrowserCount);
      return { activeBrowserCount };
    },
  });

  const flush = async () => {
    while (pending.length > 0) {
      const batch = pending.splice(0, pending.length);
      await Promise.all(batch);
    }
  };

  const request = (path: string, token = "alice-token", init: RequestInit = {}) =>
    app(
      new Request(BASE_URL + path, {
        ...init,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...Object.fromEntries(new Headers(init.headers)),
        },
      }),
    );

  const sendJson = (
    path: string,
    body: unknown,
    token = "alice-token",
    method = "POST",
  ) =>
    request(path, token, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const connectWorkerSocket = async (
    role: "browser" | "daemon" = "browser",
    token = "alice-token",
    hostId?: string,
    hostName?: string,
  ) => {
    const params = new URLSearchParams();
    if (role !== "browser") params.set("role", role);
    if (hostId) params.set("host_id", hostId);
    if (hostName) params.set("host_name", hostName);
    const qs = params.toString() ? `?${params.toString()}` : "";
    const res = await request(`/api/events${qs}`, token, {
      method: "GET",
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(101);
    const client = (res as unknown as { webSocket: MockWorkerSocket }).webSocket;
    const entry = doInstances.get("alice");
    const serverSock = [...(entry?.sockets ?? [])].at(-1)!;
    return {
      client,
      serverSock,
      disconnect() {
        serverSock.close(1000, "Client closed");
      },
      parsedEvents(): RealtimeEvent[] {
        return client.sent
          .filter(m => m.startsWith("{"))
          .map(m => JSON.parse(m) as RealtimeEvent);
      },
    };
  };

  return {
    app,
    sqlite,
    db,
    store,
    auth: new Auth(db, cfg),
    pending,
    flush,
    pushCalls,
    lastNotifyBrowserCounts,
    request,
    sendJson,
    connectWorkerSocket,
    getEventsDo,
    close() {
      sqlite.close();
    },
  };
}

async function seedAlice(h: ReturnType<typeof createWorkerRuntimeHarness>) {
  await h.db.batch([
    {
      sql: "INSERT INTO users(id, github_id, login, created_at) VALUES ('alice', '101', 'alice', '2026-11-10T00:00:00Z')",
      values: [],
    },
    {
      sql: "INSERT INTO device_tokens(id, user_id, name, token_hash, token_prefix, created_at, last_used_at, revoked_at) VALUES ('tok_alice', 'alice', 'Alice CLI', ?, 'alice-toke…', '2026-11-10T00:00:00Z', NULL, NULL)",
      values: [await hash("alice-token")],
    },
  ]);
}

function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolveWait, rejectWait) => {
    const check = async () => {
      try {
        if (await predicate()) {
          resolveWait();
          return;
        }
      } catch (err) {
        rejectWait(err);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        rejectWait(new Error(`Timed out after ${timeoutMs}ms waiting for condition`));
        return;
      }
      setTimeout(check, intervalMs);
    };
    void check();
  });
}

describe("1. Local S3 Mock, 0600 Envelope Isolation & Coding-Agent Output Parsers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("serves S3 PUT, GET, HEAD, DELETE and 404 NoSuchKey XML cleanly through startLocalS3Mock + S3Store", async () => {
    const s3Mock = await startLocalS3Mock();
    try {
      const store = new S3Store({
        S3_ENDPOINT: s3Mock.url,
        S3_BUCKET: "local-test-bucket",
        S3_REGION: "auto",
        S3_ACCESS_KEY_ID: "local-ak",
        S3_SECRET_ACCESS_KEY: "local-sk",
      });

      expect(await store.get("sites/doc1/index.html")).toBeNull();

      const rawMiss = await fetch(`${s3Mock.url}/local-test-bucket/sites/doc1/index.html`);
      expect(rawMiss.status).toBe(404);
      expect(await rawMiss.text()).toContain("<Code>NoSuchKey</Code>");

      const payload = new TextEncoder().encode("<!doctype html><h1>Safe Local R2 Mock</h1>");
      await store.put("sites/doc1/index.html", payload, "text/html; charset=utf-8");

      const headRes = await fetch(`${s3Mock.url}/local-test-bucket/sites/doc1/index.html`, {
        method: "HEAD",
      });
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(headRes.headers.get("content-length")).toBe(String(payload.byteLength));
      expect(headRes.headers.get("etag")).toBeTruthy();

      const got = await store.get("sites/doc1/index.html");
      expect(got).not.toBeNull();
      expect(await got!.text()).toBe("<!doctype html><h1>Safe Local R2 Mock</h1>");

      await store.delete("sites/doc1/index.html");
      expect(await store.get("sites/doc1/index.html")).toBeNull();
    } finally {
      await s3Mock.close();
    }
  });

  it("writes hostile prompts safely into 0600 envelope JSON for ACP prompts", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hp-envelope-sec-"));
    tempDirs.push(tmp);

    const hostilePrompt =
      "Fix hero title `rm -rf /` $(whoami)\n\r\x1b[31mDANGER\x1b[0m; echo 'pwned' \"quoted\" | cat > /tmp/pwn";

    const h = createWorkerRuntimeHarness();
    try {
      await seedAlice(h);
      const safeOpaque = encodeOpaqueBinding({
        agent: { adapter: "claude", ref: "claude-sec-1" },
      });
      const upRes = await h.request(
        `/upload?name=safe-doc&project=sec&task=ptr&host_id=hst_sec01&binding=${encodeURIComponent(safeOpaque)}`,
        "alice-token",
        {
          method: "POST",
          headers: { "Content-Type": "text/html" },
          body: "<h1>Envelope Isolation Test</h1>",
        },
      );
      expect(upRes.status).toBe(201);
      const uploaded = await upRes.json<any>();

      const createRes = await h.sendJson(
        `/api/archives/${uploaded.id}/interactions`,
        {
          requestId: "req-hostile-1",
          intent: "question",
          prompt: hostilePrompt,
        },
      );
      expect(createRes.status).toBeLessThan(300);
      const created = await createRes.json<any>();

      let capturedPrompt = "";
      const registry = createDefaultRegistry({
        acpExecutor: async ({ envelope }) => {
          capturedPrompt = envelope.ownerPrompt;
          return { replyText: "Safely answered via direct coding agent." };
        },
      });

      const envDir = join(tmp, "envelopes");
      const bridge = new DaemonServerConnection({
        credential: { serverUrl: BASE_URL, token: "alice-token" },
        identity: {
          hostId: "hst_sec01",
          hostName: "Sec-Box",
          platform: "linux",
          arch: "x64",
          createdAt: "2026-11-14T00:00:00Z",
        },
        envelopeDir: envDir,
        handoffDir: join(tmp, "handoff"),
        registry,
        connectWebSocket: false,
        fetchImpl: (input, init) => h.app(new Request(input, init)),
      });

      await bridge.drainOnce();
      await h.flush();

      expect(capturedPrompt).toBe(hostilePrompt);
      const files = readdirSync(envDir).filter(f => f.endsWith(".json"));
      expect(files.length).toBeGreaterThanOrEqual(1);
      const writtenPath = join(envDir, files.find(f => f.includes(created.interaction.id)) || files[0]!);
      expect(statSync(writtenPath).mode & 0o777).toBe(0o600);
      const parsedEnvelope = JSON.parse(readFileSync(writtenPath, "utf8")) as InteractionEnvelope;
      expect(parsedEnvelope.ownerPrompt).toBe(hostilePrompt);
    } finally {
      h.close();
    }
  });
});

describe("2. Interaction State Machine, Idempotency, Multi-turn & afterSeq Catch-Up", () => {
  let h: ReturnType<typeof createWorkerRuntimeHarness>;

  beforeEach(async () => {
    h = createWorkerRuntimeHarness();
    await seedAlice(h);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await h.flush();
    h.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("deduplicates requestId retries, increments multi-turn threadId with previousTurns, filters afterSeq, and enforces fencingToken CAS (409 on stale lease)", async () => {
    const threadOpaque = encodeOpaqueBinding({
      agent: { adapter: "claude", ref: "claude-sess-1" },
    });
    const upRes = await h.request(
      `/upload?name=thread-doc&project=proj&task=t1&binding=${encodeURIComponent(threadOpaque)}`,
      "alice-token",
      {
        method: "POST",
        headers: { "Content-Type": "text/html" },
        body: "<h1> Pricing $99 </h1>",
      },
    );
    expect(upRes.status).toBe(201);
    const doc = await upRes.json<any>();
    await h.flush();

    // 1. Idempotent retry with identical requestId
    const firstCreate = await (
      await h.sendJson(`/api/archives/${doc.id}/interactions`, {
        requestId: "mobile-retry-key-1",
        intent: "question",
        anchor: { entryPath: "index.html", exact: "Pricing $99", elementSelector: "h1" },
        prompt: "Why is pricing set to $99?",
      })
    ).json<any>();
    expect(firstCreate.deduplicated).toBe(false);
    expect(firstCreate.interaction.turnIndex).toBe(1);

    const retryCreate = await (
      await h.sendJson(`/api/archives/${doc.id}/interactions`, {
        requestId: "mobile-retry-key-1",
        intent: "question",
        prompt: "Why is pricing set to $99?",
      })
    ).json<any>();
    expect(retryCreate.deduplicated).toBe(true);
    expect(retryCreate.interaction.id).toBe(firstCreate.interaction.id);

    // 2. Claim Turn 1 and test Fencing Token CAS
    const claimMissingHost = await h.sendJson("/api/daemon/claim", {});
    expect(claimMissingHost.status).toBe(400);

    // Legacy /api/bridge/* routes are removed (404)
    expect((await h.sendJson("/api/bridge/claim", { hostId: "hst_worker_a" })).status).toBe(404);
    expect((await h.sendJson("/api/bridge/events", {})).status).toBe(404);

    const claimA = await (
      await h.sendJson("/api/daemon/claim", {
        hostId: "hst_worker_a",
        hostName: "Worker-A",
        leaseSeconds: 30,
      })
    ).json<{ deliveries: InteractionEnvelope[] }>();
    expect(claimA.deliveries).toHaveLength(1);
    const envA = claimA.deliveries[0]!;
    expect(envA.attempt).toBe(1);
    expect(envA.fencingToken).toMatch(/^fence_/);

    // Expire Lease #1 and re-claim on same host (simulating daemon crash & restart)
    h.sqlite
      .prepare("UPDATE interaction_deliveries SET lease_until = '2000-01-01T00:00:00Z' WHERE id = ?")
      .run(envA.deliveryId);

    const claimB = await (
      await h.sendJson("/api/daemon/claim", {
        hostId: "hst_worker_a",
        hostName: "Worker-A",
        leaseSeconds: 60,
      })
    ).json<{ deliveries: InteractionEnvelope[] }>();
    expect(claimB.deliveries).toHaveLength(1);
    const envB = claimB.deliveries[0]!;
    expect(envB.attempt).toBe(2);
    expect(envB.fencingToken).not.toBe(envA.fencingToken);

    // Stale Daemon A tries to report -> must fail with 409!
    const staleReport = await h.sendJson("/api/daemon/events", {
      interactionId: envA.interactionId,
      fencingToken: envA.fencingToken,
      eventKey: "stale-reply",
      kind: "replied",
      replyText: "Stale worker output",
    });
    expect(staleReport.status).toBe(409);

    // Active Daemon B reports reply -> succeeds
    const validReport = await h.sendJson("/api/daemon/events", {
      interactionId: envB.interactionId,
      fencingToken: envB.fencingToken,
      eventKey: "b-reply-1",
      kind: "replied",
      replyText: "$99 matches the annual pro tier benchmark.",
    });
    expect(validReport.status).toBe(200);
    const turn1Done = await validReport.json<any>();
    expect(turn1Done.interaction.status).toBe("replied");
    await h.flush();

    // Check state & capture seq checkpoint for afterSeq catch-up
    const stateAfterTurn1 = await (
      await h.request(`/api/archives/${doc.id}/interactions?afterSeq=0`)
    ).json<any>();
    expect(stateAfterTurn1.latestSeq).toBeGreaterThan(0);
    expect(stateAfterTurn1.events.length).toBeGreaterThanOrEqual(3); // created, leased, replied
    const checkpointSeq = stateAfterTurn1.latestSeq;

    // 3. Multi-turn follow-up on same threadId
    const turn2Create = await (
      await h.sendJson(`/api/archives/${doc.id}/interactions`, {
        requestId: "turn-2-req",
        threadId: firstCreate.interaction.threadId,
        intent: "change",
        prompt: "Great, please update it to $79 for early bird.",
      })
    ).json<any>();
    expect(turn2Create.interaction.threadId).toBe(firstCreate.interaction.threadId);
    expect(turn2Create.interaction.turnIndex).toBe(2);
    // Anchor inherited automatically from Turn 1
    expect(turn2Create.interaction.anchor?.exact).toBe("Pricing $99");

    // Claim Turn 2 and verify previousTurns context is populated in envelope
    const claimTurn2 = await (
      await h.sendJson("/api/daemon/claim", {
        hostId: "hst_worker_a",
        hostName: "Worker-A",
      })
    ).json<{ deliveries: InteractionEnvelope[] }>();
    expect(claimTurn2.deliveries).toHaveLength(1);
    expect(claimTurn2.deliveries[0]!.turnIndex).toBe(2);
    expect(claimTurn2.deliveries[0]!.previousTurns).toEqual([
      {
        turnIndex: 1,
        prompt: "Why is pricing set to $99?",
        replyText: "$99 matches the annual pro tier benchmark.",
        resultVersion: null,
      },
    ]);

    // 4. Incremental catch-up via afterSeq
    const incremental = await (
      await h.request(`/api/archives/${doc.id}/interactions?afterSeq=${checkpointSeq}`)
    ).json<any>();
    expect(incremental.events.length).toBeGreaterThan(0);
    expect(incremental.events.every((e: any) => e.seq > checkpointSeq)).toBe(true);
    expect(incremental.latestSeq).toBe(incremental.events.at(-1).seq);

    const upToDate = await (
      await h.request(`/api/archives/${doc.id}/interactions?afterSeq=${incremental.latestSeq}`)
    ).json<any>();
    expect(upToDate.events).toEqual([]);
    expect(upToDate.latestSeq).toBe(incremental.latestSeq);
  });
});

describe("3. Coexistence of HTML v2 Upload (--resolves) and Structured Text Reply", () => {
  let h: ReturnType<typeof createWorkerRuntimeHarness>;

  beforeEach(async () => {
    h = createWorkerRuntimeHarness();
    await seedAlice(h);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await h.flush();
    h.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves BOTH status === 'updated', resultVersion === 2, AND replyText intact regardless of v2 upload vs reply ordering", async () => {
    const coexistOpaque = encodeOpaqueBinding({
      agent: { adapter: "claude", ref: "sess-coexist" },
    });
    const doc = await (
      await h.request(
        `/upload?name=coexist-doc&project=ui&task=rev&binding=${encodeURIComponent(coexistOpaque)}`,
        "alice-token",
        {
          method: "POST",
          headers: { "Content-Type": "text/html" },
          body: "<h1>v1 Draft</h1>",
        },
      )
    ).json<any>();

    // Interaction A: Agent uploads v2 with resolves=<id> first, then Daemon reports structured replyText
    const createdA = await (
      await h.sendJson(`/api/archives/${doc.id}/interactions`, {
        requestId: "coexist-a",
        intent: "change",
        prompt: "Make heading bold blue and explain why.",
      })
    ).json<any>();
    const intIdA = createdA.interaction.id as string;

    const claimedA = (
      await (await h.sendJson("/api/daemon/claim", { hostId: "hst_b1" })).json<{
        deliveries: InteractionEnvelope[];
      }>()
    ).deliveries[0]!;

    const workingRes = await h.sendJson("/api/daemon/events", {
      interactionId: intIdA,
      fencingToken: claimedA.fencingToken,
      eventKey: "work-a",
      kind: "working",
      summary: "Claude 正在重构样式…",
    });
    expect((await workingRes.json<any>()).interaction.status).toBe("working");

    // Agent uploads v2 with resolves=<intIdA>
    const v2Res = await h.request(
      `/upload?name=coexist-doc&resolves=${encodeURIComponent(intIdA)}&note=Bold+blue+header`,
      "alice-token",
      {
        method: "POST",
        headers: { "Content-Type": "text/html" },
        body: "<h1 style='color:#2563eb;font-weight:800'>v2 Final</h1>",
      },
    );
    expect(v2Res.status).toBe(201);
    const v2Body = await v2Res.json<any>();
    expect(v2Body.version).toBe(2);

    // Daemon finishes and reports structured replyText
    const replyARes = await (
      await h.sendJson("/api/daemon/events", {
        interactionId: intIdA,
        fencingToken: claimedA.fencingToken,
        eventKey: "reply-a",
        kind: "replied",
        replyText: "Updated `<h1>` to `#2563eb` with weight `800` for WCAG AAA contrast.",
      })
    ).json<any>();

    expect(replyARes.interaction.status).toBe("updated");
    expect(replyARes.interaction.resultVersion).toBe(2);
    expect(replyARes.interaction.replyText).toBe(
      "Updated `<h1>` to `#2563eb` with weight `800` for WCAG AAA contrast.",
    );

    // Interaction B: Reverse order — Agent posts callback reply first, then uploads v3 with resolves=<id>
    const createdB = await (
      await h.sendJson(`/api/archives/${doc.id}/interactions`, {
        requestId: "coexist-b",
        intent: "change",
        prompt: "Add subtitle under h1.",
      })
    ).json<any>();
    const intIdB = createdB.interaction.id as string;

    await h.sendJson(`/api/interactions/${intIdB}/reply`, {
      replyText: "Added responsive subtitle paragraph below the hero title.",
    });
    await h.request(
      `/upload?name=coexist-doc&resolves=${encodeURIComponent(intIdB)}`,
      "alice-token",
      {
        method: "POST",
        headers: { "Content-Type": "text/html" },
        body: "<h1>v3</h1><p>Subtitle</p>",
      },
    );

    const docState = await (
      await h.request(`/api/archives/${doc.id}/interactions`)
    ).json<any>();
    const intBFinal = docState.interactions.find((i: InteractionRecord) => i.id === intIdB) as InteractionRecord;
    expect(intBFinal.status).toBe("updated");
    expect(intBFinal.resultVersion).toBe(3);
    expect(intBFinal.replyText).toBe("Added responsive subtitle paragraph below the hero title.");
  });
});

describe("4. Minimal CodingAgentAdapter Interface (sendMessage, listSessions, locateArtifactSource)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("supports sendMessage, listSessions (cwd-filtered & sorted), and locateArtifactSource (including cross-host handoff HTML snapshot)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hp-coding-adapters-"));
    tempDirs.push(tmp);
    const fakeHome = join(tmp, "home");
    const repoA = "/workspace/repo-a";
    const repoB = "/workspace/repo-b";

    // Seed Codex sessions for repoA & repoB
    const codexDay = join(fakeHome, ".codex", "sessions", "2026", "11", "14");
    mkdirSync(codexDay, { recursive: true });
    const codexA = "019da8fc-1111-7ab3-a2c3-d93b5a06db1d";
    const codexB = "019da8fc-2222-7ab3-a2c3-d93b5a06db1d";
    writeFileSync(
      join(codexDay, `rollout-a-${codexA}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: codexA, cwd: repoA } })}\n`,
      "utf-8",
    );
    writeFileSync(
      join(codexDay, `rollout-b-${codexB}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: codexB, cwd: repoB } })}\n`,
      "utf-8",
    );

    const codexAdapter = new CodexAdapter({ homeDir: fakeHome });
    const filteredA = await codexAdapter.listSessions({ cwd: repoA });
    expect(filteredA).toHaveLength(1);
    expect(filteredA[0]?.sessionRef).toBe(codexA);
    expect(filteredA[0]?.cwd).toBe(repoA);

    // Verify AgyAdapter sendMessage + locateArtifactSource
    const workingNotes: string[] = [];
    const agyAdapter = new AgyAdapter({
      homeDir: fakeHome,
      executor: async ({ agentId, binding, promptText, source }) => {
        expect(agentId).toBe("agy");
        expect(binding.sessionRef).toBe("agy-sess-7");
        expect(source.cwd).toBe(tmp);
        expect(promptText).toContain("Explain layout grid");
        return { replyText: "We use a 12-column CSS Grid with 24px gap." };
      },
    });

    const baseEnvelope: InteractionEnvelope = {
      interactionId: "int_cap_1",
      threadId: "int_cap_1",
      turnIndex: 1,
      deliveryId: "dlv_cap_1",
      attempt: 1,
      fencingToken: "fence_cap_1",
      document: {
        id: "doc_cap",
        publicId: "grid-doc",
        name: "grid",
        title: "Grid Spec",
        baseVersion: 1,
        versionUrl: `${BASE_URL}/p/grid-doc/v1/`,
      },
      binding: {
        id: "bind_cap",
        documentId: "doc_cap",
        version: 1,
        adapterId: "agy",
        sessionRef: "agy-sess-7",
        cwd: tmp,
        sourceFile: "index.html",
        adapterMeta: {},
        createdAt: "2026-11-14T00:00:00Z",
      },
      anchor: null,
      intent: "question",
      ownerPrompt: "Explain layout grid",
      createdAt: "2026-11-14T00:00:00Z",
    };

    const source = await agyAdapter.locateArtifactSource(baseEnvelope);
    expect(source).toEqual({ cwd: tmp, sourceFile: "index.html" });

    const reply = await agyAdapter.sendMessage({
      envelope: baseEnvelope,
      envelopePath: join(tmp, "int_cap_1.json"),
      source,
      onWorking: async summary => {
        workingNotes.push(summary);
      },
    });
    expect(workingNotes).toEqual(["正在通过 Antigravity CLI 会话处理…"]);
    expect(reply).toMatchObject({
      replyText: "We use a 12-column CSS Grid with 24px gap.",
      sessionRef: "agy-sess-7",
      resumed: true,
    });

    // Verify cross-host handoff locateArtifactSource materializes online HTML snapshot with 0600 permissions
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html><h1>Online Snapshot</h1>", { status: 200 })),
    );
    const handoffSource = await new ClaudeCodeAdapter({ homeDir: fakeHome }).locateArtifactSource({
      ...baseEnvelope,
      binding: {
        ...baseEnvelope.binding,
        cwd: null,
        sourceFile: null,
        adapterMeta: {
          handoffFromHostId: "hst_sleeping_mac",
          daemonHandoffDir: join(tmp, "handoff"),
          daemonServerToken: "alice-token",
        },
      },
    });
    expect(handoffSource.handoffMaterialized).toBe(true);
    expect(handoffSource.sourceFile).toBe("index.html");
    const snapFile = join(handoffSource.cwd!, "index.html");
    expect(readFileSync(snapFile, "utf-8")).toBe("<!doctype html><h1>Online Snapshot</h1>");
    expect(statSync(snapFile).mode & 0o777).toBe(0o600);
  });
});

describe("5. Active Browser Suppresses Push; Offline Pushes ONLY to Single Most Recent Device", () => {
  let h: ReturnType<typeof createWorkerRuntimeHarness>;

  beforeEach(async () => {
    h = createWorkerRuntimeHarness();
    await seedAlice(h);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await h.flush();
    h.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("suppresses Web Push while browser WS is open (even with daemon WS open), and pushes ONLY to single most recent device once browser WS closes", async () => {
    // Register 2 Web Push subscriptions: device-older then device-newer
    const subOlderRes = await h.sendJson("/api/push/subscriptions", {
      endpoint: "https://push.example/sub/device-older",
      keys: { p256dh: "key_older_p256dh", auth: "key_older_auth" },
      userAgent: "iPhone Safari Older",
    });
    expect(subOlderRes.status).toBeLessThan(300);
    h.sqlite
      .prepare("UPDATE push_subscriptions SET updated_at = '2026-11-10T01:00:00.000Z' WHERE endpoint = ?")
      .run("https://push.example/sub/device-older");

    const subNewerRes = await h.sendJson("/api/push/subscriptions", {
      endpoint: "https://push.example/sub/device-newer",
      keys: { p256dh: "key_newer_p256dh", auth: "key_newer_auth" },
      userAgent: "Pixel Chrome Newer",
    });
    expect(subNewerRes.status).toBeLessThan(300);
    h.sqlite
      .prepare("UPDATE push_subscriptions SET updated_at = '2026-11-13T10:00:00.000Z' WHERE endpoint = ?")
      .run("https://push.example/sub/device-newer");

    const o4Opaque = encodeOpaqueBinding({
      agent: { adapter: "claude", ref: "sess-o4" },
    });
    const doc = await (
      await h.request(
        `/upload?name=o4-push-doc&project=pwa&task=push&binding=${encodeURIComponent(o4Opaque)}`,
        "alice-token",
        {
          method: "POST",
          headers: { "Content-Type": "text/html" },
          body: "<h1>PWA Push Spec</h1>",
        },
      )
    ).json<any>();
    await h.flush();

    // Connect BOTH a browser WebSocket (/api/events) AND a daemon WebSocket (/api/events?role=daemon)
    const browserWs = await h.connectWorkerSocket("browser");
    const daemonWs = await h.connectWorkerSocket("daemon", "alice-token", "hst_o4_bg", "O4-Daemon");

    const int1 = await (
      await h.sendJson(`/api/archives/${doc.id}/interactions`, {
        requestId: "o4-online-1",
        intent: "question",
        prompt: "Reply while browser tab is open",
      })
    ).json<any>();
    await h.flush();

    // Complete interaction #1 while browser WS is open
    const reply1 = await h.sendJson(`/api/interactions/${int1.interaction.id}/reply`, {
      replyText: "In-page toast only — no OS push spam!",
    });
    expect(reply1.status).toBe(200);
    await h.flush();

    const browserInteractionEvents = browserWs
      .parsedEvents()
      .filter(e => e.type === "interaction" && e.interaction.id === int1.interaction.id);
    expect(browserInteractionEvents.some(e => e.type === "interaction" && e.kind === "replied")).toBe(true);
    expect(h.pushCalls).toHaveLength(0);

    // Disconnect Browser WS while Daemon WS REMAINS CONNECTED!
    browserWs.disconnect();
    expect(daemonWs.serverSock.closed).toBeNull();

    const int2 = await (
      await h.sendJson(`/api/archives/${doc.id}/interactions`, {
        requestId: "o4-offline-2",
        intent: "question",
        prompt: "Reply after phone screen locked / browser closed",
      })
    ).json<any>();
    await h.flush();

    const reply2 = await h.sendJson(`/api/interactions/${int2.interaction.id}/reply`, {
      replyText: "Delivered via Web Push to single most recent device!",
    });
    expect(reply2.status).toBe(200);
    await h.flush();

    expect(h.lastNotifyBrowserCounts.at(-1)?.alice).toBe(0);
    expect(h.pushCalls).toHaveLength(1);
    expect(h.pushCalls[0]!.subscriptions).toHaveLength(1);
    expect(h.pushCalls[0]!.subscriptions[0]!.endpoint).toBe("https://push.example/sub/device-newer");
    expect(h.pushCalls[0]!.payload).toMatchObject({
      documentId: doc.id,
      interactionId: int2.interaction.id,
      kind: "replied",
    });
  });
});

describe("6. Dual-Runtime Parity Proof (Cloudflare HtmlPreviewEvents DO vs Self-Hosted startNodePreviewServer + ws)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("Runtime A (Cloudflare Worker createApp + HtmlPreviewEvents DO): tracks role=browser vs role=daemon, emits X-Html-Preview-Active-Browsers, and directly resumes coding agent", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hp-worker-e2e-"));
    tempDirs.push(tmp);

    const h = createWorkerRuntimeHarness();
    try {
      await seedAlice(h);

      await h.sendJson("/api/push/subscriptions", {
        endpoint: "https://push.example/cf/older",
        keys: { p256dh: "p_old", auth: "a_old" },
      });
      h.sqlite
        .prepare("UPDATE push_subscriptions SET updated_at = '2026-11-01T00:00:00.000Z' WHERE endpoint = ?")
        .run("https://push.example/cf/older");

      await h.sendJson("/api/push/subscriptions", {
        endpoint: "https://push.example/cf/newer",
        keys: { p256dh: "p_new", auth: "a_new" },
      });
      h.sqlite
        .prepare("UPDATE push_subscriptions SET updated_at = '2026-11-13T12:00:00.000Z' WHERE endpoint = ?")
        .run("https://push.example/cf/newer");

      const cfOpaque = encodeOpaqueBinding({
        agent: { adapter: "claude", ref: "claude-cf-99" },
      });
      const doc = await (
        await h.request(
          `/upload?name=cf-parity&project=dual&task=e2e&host_id=hst_cf01&binding=${encodeURIComponent(cfOpaque)}`,
          "alice-token",
          {
            method: "POST",
            headers: { "Content-Type": "text/html" },
            body: "<h1>Cloudflare v1</h1>",
          },
        )
      ).json<any>();
      await h.flush();

      const browserWs = await h.connectWorkerSocket("browser");
      const daemonWs = await h.connectWorkerSocket("daemon", "alice-token", "hst_cf01", "CF-Daemon");

      const directDoPing1 = await h.getEventsDo("alice").doInstance.fetch(
        new Request("https://html-preview/changed", { method: "POST" }),
      );
      expect(directDoPing1.status).toBe(204);
      expect(directDoPing1.headers.get("X-Html-Preview-Active-Browsers")).toBe("1");

      const registry = createDefaultRegistry({
        acpExecutor: async ({ agentId, binding, envelope }) => {
          const nextOpaque = encodeOpaqueBinding({
            agent: { adapter: agentId, ref: binding.sessionRef },
          });
          const v2Res = await h.request(
            `/upload?name=${encodeURIComponent(envelope.document.name)}&resolves=${encodeURIComponent(envelope.interactionId)}&host_id=hst_cf01&binding=${encodeURIComponent(nextOpaque)}`,
            "alice-token",
            {
              method: "POST",
              headers: { "Content-Type": "text/html" },
              body: "<h1>Cloudflare v2 Updated Directly by Claude</h1>",
            },
          );
          const v2Json = await v2Res.json<any>();
          return {
            newVersion: v2Json.version,
            replyText: `Resumed ${agentId} (${binding.sessionRef}) and published v${v2Json.version}.`,
          };
        },
      });

      const bridge = new DaemonServerConnection({
        credential: { serverUrl: BASE_URL, token: "alice-token" },
        identity: {
          hostId: "hst_cf01",
          hostName: "CF-Daemon",
          platform: "linux",
          arch: "x64",
          createdAt: "2026-11-14T00:00:00Z",
        },
        envelopeDir: join(tmp, "cf-envelopes"),
        handoffDir: join(tmp, "cf-handoff"),
        registry,
        connectWebSocket: false,
        fetchImpl: (input, init) => h.app(new Request(input, init)),
      });

      const int1 = await (
        await h.sendJson(`/api/archives/${doc.id}/interactions`, {
          requestId: "cf-e2e-1",
          intent: "change",
          prompt: "Upgrade Cloudflare v1 to v2",
        })
      ).json<any>();
      await h.flush();

      expect(
        daemonWs.client.sent.some(m => m.startsWith("{") && JSON.parse(m).type === "daemon_wake"),
      ).toBe(true);

      await bridge.drainOnce();
      await h.flush();

      const state1 = await (await h.request(`/api/archives/${doc.id}/interactions`)).json<any>();
      const resolved1 = state1.interactions.find(
        (i: InteractionRecord) => i.id === int1.interaction.id,
      ) as InteractionRecord;
      expect(resolved1.status).toBe("updated");
      expect(resolved1.resultVersion).toBe(2);
      expect(resolved1.effectiveAdapterId).toBe("Claude");
      expect(resolved1.replyText).toBe("Resumed claude (claude-cf-99) and published v2.");
      expect(h.pushCalls).toHaveLength(0);

      browserWs.disconnect();
      const directDoPing2 = await h.getEventsDo("alice").doInstance.fetch(
        new Request("https://html-preview/changed", { method: "POST" }),
      );
      expect(directDoPing2.headers.get("X-Html-Preview-Active-Browsers")).toBe("0");

      const int2 = await (
        await h.sendJson(`/api/archives/${doc.id}/interactions`, {
          requestId: "cf-e2e-2",
          intent: "question",
          prompt: "Confirm offline push on Cloudflare DO",
        })
      ).json<any>();
      await bridge.drainOnce();
      await h.flush();

      const cfPushes = h.pushCalls.filter(p => p.payload.interactionId === int2.interaction.id);
      expect(cfPushes.length).toBeGreaterThanOrEqual(1);
      for (const call of cfPushes) {
        expect(call.subscriptions).toHaveLength(1);
        expect(call.subscriptions[0]!.endpoint).toBe("https://push.example/cf/newer");
      }
    } finally {
      h.close();
    }
  });

  it("Runtime B (Self-Hosted startNodePreviewServer + ws): achieves 1:1 end-to-end parity across real ws WebSockets + DaemonServerConnection", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hp-node-e2e-"));
    tempDirs.push(tmp);

    const s3Mock = await startLocalS3Mock();
    const pushCalls: Array<{
      subscriptions: PushSubscriptionRecord[];
      payload: WebPushNotificationPayload;
    }> = [];

    const store = new S3Store({
      S3_ENDPOINT: s3Mock.url,
      S3_BUCKET: "node-parity-bucket",
      S3_REGION: "auto",
      S3_ACCESS_KEY_ID: "local-ak",
      S3_SECRET_ACCESS_KEY: "local-sk",
    });

    const nodeServer = await startNodePreviewServer({
      ALLOW_DEV_LOGIN: "1",
      ADMIN_GITHUB_LOGIN: "alice",
      port: 0,
      host: "127.0.0.1",
      databasePath: join(tmp, "node-preview.sqlite"),
      store,
      VAPID_PUBLIC_KEY: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
      pushDispatcher: async (subscriptions, payload) => {
        pushCalls.push({ subscriptions, payload });
      },
    });

    let bridge: DaemonServerConnection | null = null;
    let browserWs: WebSocket | null = null;

    try {
      const loginRes = await fetch(`${nodeServer.url}/auth/dev-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          login: "alice",
          issueDeviceToken: true,
          deviceName: "Node Parity Daemon",
        }),
      });
      expect(loginRes.status).toBe(200);
      const loginBody = (await loginRes.json()) as {
        user: { id: string; login: string };
        deviceToken: string;
      };
      const sessionCookie = loginRes.headers
        .getSetCookie()
        .find(c => c.startsWith("hp_session="))!
        .split(";")[0]!;
      const token = loginBody.deviceToken;
      const userId = loginBody.user.id;

      await fetch(`${nodeServer.url}/api/push/subscriptions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          endpoint: "https://push.example/node/older",
          keys: { p256dh: "p_old", auth: "a_old" },
          userAgent: "Older Tablet",
        }),
      });
      nodeServer.sqlite
        .prepare("UPDATE push_subscriptions SET updated_at = '2026-11-01T00:00:00.000Z' WHERE endpoint = ?")
        .run("https://push.example/node/older");

      await fetch(`${nodeServer.url}/api/push/subscriptions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          endpoint: "https://push.example/node/newer",
          keys: { p256dh: "p_new", auth: "a_new" },
          userAgent: "Newer Phone",
        }),
      });
      nodeServer.sqlite
        .prepare("UPDATE push_subscriptions SET updated_at = '2026-11-13T12:00:00.000Z' WHERE endpoint = ?")
        .run("https://push.example/node/newer");

      const nodeOpaque = encodeOpaqueBinding({
        agent: { adapter: "claude", ref: "claude-node-99" },
      });
      const upRes = await fetch(
        `${nodeServer.url}/upload?name=node-parity&project=dual&task=e2e&host_id=hst_node01&host_name=Node-Box&binding=${encodeURIComponent(nodeOpaque)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "text/html",
          },
          body: "<h1>Node v1</h1>",
        },
      );
      expect(upRes.status).toBe(201);
      const doc = (await upRes.json()) as { id: string; name: string; version: number };

      const browserMessages: RealtimeEvent[] = [];
      const wsUrl = nodeServer.url.replace(/^http/, "ws");
      browserWs = new WebSocket(`${wsUrl}/api/events`, {
        headers: {
          Cookie: sessionCookie,
          Origin: nodeServer.url,
        },
      });
      await new Promise<void>((resolveOpen, rejectOpen) => {
        browserWs!.once("open", () => resolveOpen());
        browserWs!.once("error", rejectOpen);
      });
      browserWs.on("message", raw => {
        const text = String(raw);
        if (text.startsWith("{")) {
          browserMessages.push(JSON.parse(text) as RealtimeEvent);
        }
      });

      const registry = createDefaultRegistry({
        acpExecutor: async ({ agentId, binding, envelope }) => {
          const nextOpaque = encodeOpaqueBinding({
            agent: { adapter: agentId, ref: binding.sessionRef },
          });
          const v2Upload = await fetch(
            `${nodeServer.url}/upload?name=${encodeURIComponent(envelope.document.name)}&resolves=${encodeURIComponent(envelope.interactionId)}&host_id=hst_node01&binding=${encodeURIComponent(nextOpaque)}`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "text/html",
              },
              body: "<h1>Node v2 Updated Directly by Claude</h1>",
            },
          );
          const v2Json = (await v2Upload.json()) as { version: number };
          return {
            newVersion: v2Json.version,
            replyText: `Resumed ${agentId} (${binding.sessionRef}) and published v${v2Json.version}.`,
          };
        },
      });

      bridge = new DaemonServerConnection({
        credential: { serverUrl: nodeServer.url, token },
        identity: {
          hostId: "hst_node01",
          hostName: "Node-Box",
          platform: "linux",
          arch: "x64",
          createdAt: "2026-11-14T00:00:00Z",
        },
        envelopeDir: join(tmp, "bridge-envelopes"),
        handoffDir: join(tmp, "bridge-handoff"),
        registry,
        idleSweepIntervalMs: 5000,
      });
      await bridge.start();

      await waitForCondition(() => {
        const counts = nodeServer.getActiveSocketCounts(userId);
        return counts.browser === 1 && counts.daemon === 1;
      });

      const createInt1 = await fetch(`${nodeServer.url}/api/archives/${doc.id}/interactions`, {
        method: "POST",
        headers: {
          Cookie: sessionCookie,
          Origin: nodeServer.url,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: "node-e2e-1",
          intent: "change",
          prompt: "Upgrade Node v1 to v2",
        }),
      });
      expect(createInt1.status).toBeLessThan(300);
      const int1Body = (await createInt1.json()) as { interaction: InteractionRecord };

      await waitForCondition(() =>
        browserMessages.some(
          m =>
            m.type === "interaction" &&
            m.interaction.id === int1Body.interaction.id &&
            m.interaction.status === "updated" &&
            Boolean(m.interaction.replyText),
        ),
      );

      const state1Res = await fetch(`${nodeServer.url}/api/archives/${doc.id}/interactions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const state1 = (await state1Res.json()) as { interactions: InteractionRecord[] };
      const resolved1 = state1.interactions.find(i => i.id === int1Body.interaction.id)!;
      expect(resolved1.status).toBe("updated");
      expect(resolved1.resultVersion).toBe(2);
      expect(resolved1.effectiveAdapterId).toBe("Claude");
      expect(resolved1.replyText).toBe("Resumed claude (claude-node-99) and published v2.");
      expect(pushCalls).toHaveLength(0);

      await new Promise<void>(resolveClose => {
        browserWs!.once("close", () => resolveClose());
        browserWs!.close();
      });
      browserWs = null;

      await waitForCondition(() => {
        const counts = nodeServer.getActiveSocketCounts(userId);
        return counts.browser === 0 && counts.daemon === 1;
      });

      const createInt2 = await fetch(`${nodeServer.url}/api/archives/${doc.id}/interactions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: "node-e2e-2",
          intent: "question",
          prompt: "Confirm offline push delivery",
        }),
      });
      expect(createInt2.status).toBeLessThan(300);
      const int2Body = (await createInt2.json()) as { interaction: InteractionRecord };

      await waitForCondition(() =>
        pushCalls.some(p => p.payload.interactionId === int2Body.interaction.id),
      );

      const int2Pushes = pushCalls.filter(p => p.payload.interactionId === int2Body.interaction.id);
      expect(int2Pushes.length).toBeGreaterThanOrEqual(1);
      for (const call of int2Pushes) {
        expect(call.subscriptions).toHaveLength(1);
        expect(call.subscriptions[0]!.endpoint).toBe("https://push.example/node/newer");
      }
    } finally {
      if (browserWs) browserWs.close();
      if (bridge) await bridge.stop();
      await nodeServer.close();
      await s3Mock.close();
    }
  });

  it("supports zero-manual-binding on historical unbound pages (auto-routes to available coding agent and persists discoveredSessionRef for follow-up turns)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hp-zero-bind-"));
    const h = createWorkerRuntimeHarness();
    try {
      await seedAlice(h);

      // 1. Historical page uploaded WITHOUT any adapter/session_ref
      const doc = await (
        await h.request("/upload?name=legacy-doc&project=p&task=legacy", "alice-token", {
          method: "POST",
          headers: { "Content-Type": "text/html" },
          body: "<title>Legacy Report</title><h1>Historical Page</h1>",
        })
      ).json<any>();

      // 2. Owner sends natural-language comment WITHOUT binding a session or choosing an intent -> 201 ("auto")
      const int1Res = await h.sendJson(`/api/archives/${doc.id}/interactions`, {
        requestId: "legacy-req-1",
        prompt: "把标题字号调小一点，并说明原因",
      });
      expect(int1Res.status).toBe(201);
      const int1 = await int1Res.json<any>();
      expect(int1.interaction.targetAdapterId).toBe("auto");

      const calls: Array<{ agentId: string; sessionRef: string }> = [];
      const registry = createDefaultRegistry({
        acpExecutor: async ({ agentId, binding }) => {
          calls.push({ agentId, sessionRef: binding.sessionRef });
          return {
            replyText: `Handled via ${agentId} (${binding.sessionRef})`,
            sessionRef: "claude_spawned_uuid_01",
          };
        },
      });

      const bridge = new DaemonServerConnection({
        credential: { serverUrl: BASE_URL, token: "alice-token" },
        identity: {
          hostId: "hst_auto01",
          hostName: "Auto-Box",
          platform: "linux",
          arch: "x64",
          createdAt: "2026-11-14T00:00:00Z",
        },
        envelopeDir: join(tmp, "envelopes"),
        handoffDir: join(tmp, "handoff"),
        connectWebSocket: false,
        registry,
        fetchImpl: (input, init) => h.app(new Request(input, init)),
      });

      await bridge.drainOnce();
      await h.flush();

      expect(calls).toEqual([{ agentId: "codex", sessionRef: "adhoc" }]);

      const stateAfter1 = await (
        await h.request(`/api/archives/${doc.id}/interactions`)
      ).json<any>();
      expect(stateAfter1.bindings).toHaveLength(1);
      expect(stateAfter1.bindings[0].adapterId).toBe("codex");
      expect(stateAfter1.bindings[0].hostId).toBe("hst_auto01");

      const rec1 = stateAfter1.interactions.find(
        (i: InteractionRecord) => i.id === int1.interaction.id,
      ) as InteractionRecord;
      expect(rec1.status).toBe("replied");
      expect(rec1.effectiveAdapterId).toBe("Codex");

      // 3. Follow-up Turn #2 on the same page automatically uses the newly persisted claude_spawned_uuid_01 session!
      const int2Res = await h.sendJson(`/api/archives/${doc.id}/interactions`, {
        requestId: "legacy-req-2",
        threadId: int1.interaction.threadId,
        prompt: "再把副标题颜色改浅",
      });
      expect(int2Res.status).toBe(201);
      await bridge.drainOnce();
      await h.flush();

      expect(calls[1]).toEqual({
        agentId: "codex",
        sessionRef: "claude_spawned_uuid_01",
      });
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      h.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
