import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../src/app";
import { Auth, requestCredential, type AuthConfig } from "../src/auth";
import { d1Database } from "../src/database";
import { HtmlPreviewEvents } from "../src/events";
import { startNodePreviewServer, type RunningNodePreviewServer } from "../src/node-server";
import { applyMigrations, sqliteDatabase } from "../src/node-db";
import type { ObjectStore } from "../src/storage";
import type { HostPresenceInfo, PresenceSnapshot, RealtimeEvent } from "../src/interact-types";
import { DatabaseSync } from "node:sqlite";

const BASE_URL = "https://preview.example";

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

class MockDoSocket {
  public sent: string[] = [];
  public closed = false;
  public closeCode?: number;
  private attachment: unknown = null;
  constructor(private peer?: MockDoSocket) {}
  setPeer(peer: MockDoSocket) {
    this.peer = peer;
  }
  send(data: string | ArrayBufferView | ArrayBuffer) {
    const str = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBufferView);
    if (this.peer) this.peer.sent.push(str);
    else this.sent.push(str);
  }
  close(code?: number) {
    this.closed = true;
    this.closeCode = code;
    if (this.peer && !this.peer.closed) {
      this.peer.closed = true;
      this.peer.closeCode = code;
    }
  }
  serializeAttachment(val: unknown) {
    this.attachment = JSON.parse(JSON.stringify(val));
  }
  deserializeAttachment() {
    return this.attachment;
  }
}

function createWorkerDoHarness() {
  vi.stubGlobal("WebSocketRequestResponsePair", class {});
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0: MockDoSocket;
      1: MockDoSocket;
      constructor() {
        const c = new MockDoSocket();
        const s = new MockDoSocket(c);
        c.setPeer(s);
        this[0] = c;
        this[1] = s;
      }
    },
  );
  const origResponse = globalThis.Response;
  const PatchedResponse = function (
    body?: BodyInit | null,
    init?: ResponseInit & { webSocket?: unknown },
  ) {
    if (init && "webSocket" in init && init.status === 101) {
      const { webSocket, ...rest } = init;
      const r = new origResponse(null, { ...rest, status: 200 });
      Object.defineProperty(r, "status", { value: 101 });
      Object.defineProperty(r, "webSocket", { value: webSocket });
      return r;
    }
    return new origResponse(body, init);
  } as unknown as typeof Response;
  PatchedResponse.json = origResponse.json.bind(origResponse);
  PatchedResponse.redirect = origResponse.redirect.bind(origResponse);
  PatchedResponse.error = origResponse.error.bind(origResponse);
  vi.stubGlobal("Response", PatchedResponse);

  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const db = sqliteDatabase(sqlite);
  const store = createMemoryObjectStore();
  const pending: Promise<unknown>[] = [];

  const d1Binding = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        all: async () => ({ results: sqlite.prepare(sql).all(...(values as never[])) }),
      }),
    }),
    batch: async (stmts: Array<{ all: () => Promise<{ results: unknown[] }> }>) =>
      Promise.all(stmts.map(s => s.all())),
  } as unknown as D1Database;

  const doSockets = new Set<MockDoSocket>();
  const doState = {
    setWebSocketAutoResponse() {},
    acceptWebSocket(ws: unknown) {
      doSockets.add(ws as MockDoSocket);
    },
    getWebSockets() {
      return [...doSockets].filter(s => !s.closed);
    },
  } as unknown as DurableObjectState;
  const eventsDo = new HtmlPreviewEvents(doState, { DB: d1Binding });

  const cfg: AuthConfig = {
    PUBLIC_BASE_URL: BASE_URL,
    ALLOW_DEV_LOGIN: "true",
  };
  const app = createApp({
    ...cfg,
    db: d1Database(d1Binding),
    store,
    defer(p) {
      pending.push(p);
    },
    async events(req) {
      const headers = new Headers(req.headers);
      const url = new URL(req.url);
      const rawRole = url.searchParams.get("role");
      const role = rawRole === "daemon" ? "daemon" : "browser";
      headers.set("X-Html-Preview-Credential", JSON.stringify(await requestCredential(req)));
      headers.set("X-Html-Preview-Role", role);
      return eventsDo.fetch(new Request(req, { headers }));
    },
    async disconnect() {
      await eventsDo.fetch(new Request("https://html-preview/revalidate", { method: "POST" }));
    },
    async presence(): Promise<PresenceSnapshot> {
      const r = await eventsDo.fetch(new Request("https://html-preview/presence", { method: "GET" }));
      return (await r.json()) as PresenceSnapshot;
    },
    async notify(users, event, opts) {
      const headers = new Headers();
      if (opts?.targetRole) headers.set("X-Html-Preview-Target-Role", opts.targetRole);
      if (opts?.targetHostId) headers.set("X-Html-Preview-Target-Host", opts.targetHostId);
      const r = await eventsDo.fetch(
        new Request("https://html-preview/changed", {
          method: "POST",
          headers,
          body: event ? JSON.stringify(event) : undefined,
        }),
      );
      const count = Number(r.headers.get("X-Html-Preview-Active-Browsers") || "0") || 0;
      const hosts = JSON.parse(r.headers.get("X-Html-Preview-Online-Hosts") || "[]") as HostPresenceInfo[];
      return {
        activeBrowserCount: Object.fromEntries(users.map(u => [u, count])),
        onlineHosts: Object.fromEntries(users.map(u => [u, hosts])),
      };
    },
  });

  const flush = async () => {
    while (pending.length) {
      const batch = pending.splice(0);
      await Promise.all(batch);
    }
  };

  return { sqlite, db, auth: new Auth(db, cfg), app, eventsDo, doSockets, flush };
}

describe("Phase 1: Multi-Host Daemon Routing, Sleep Queue, Handoff, Lease Renewal & Dual-Runtime Presence", () => {
  const serversToClose: RunningNodePreviewServer[] = [];

  afterEach(async () => {
    for (const s of serversToClose.splice(0)) {
      await s.close();
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("Cloudflare DO Runtime: enforces strict host affinity (no job stealing), targeted daemon_wake, sleep queue, handoff, renew, and discoveredBinding", async () => {
    const h = createWorkerDoHarness();
    try {
      const devRes = await h.app(
        new Request(`${BASE_URL}/auth/dev-login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ login: "alice", issueDeviceToken: true }),
        }),
      );
      const { deviceToken } = (await devRes.json()) as { deviceToken: string };
      const authHeaders = { Authorization: `Bearer ${deviceToken}` };

      // Connect browser + 2 online daemons: MacBook Pro (hst_mac01) and GrokBot Box (hst_box02)
      const browserUpgrade = await h.app(
        new Request(`${BASE_URL}/api/events`, {
          headers: { ...authHeaders, Upgrade: "websocket" },
        }),
      );
      const browserClient = (browserUpgrade as unknown as { webSocket: MockDoSocket }).webSocket;

      const macUpgrade = await h.app(
        new Request(
          `${BASE_URL}/api/events?role=daemon&host_id=hst_mac01&host_name=MacBook%20Pro&ver=1.1.0`,
          { headers: { ...authHeaders, Upgrade: "websocket" } },
        ),
      );
      const macClient = (macUpgrade as unknown as { webSocket: MockDoSocket }).webSocket;
      const macServerSock = [...h.doSockets].at(-1)!;

      const boxUpgrade = await h.app(
        new Request(
          `${BASE_URL}/api/events?role=daemon&host_id=hst_box02&host_name=grok-bot-box&ver=1.1.0`,
          { headers: { ...authHeaders, Upgrade: "websocket" } },
        ),
      );
      const boxClient = (boxUpgrade as unknown as { webSocket: MockDoSocket }).webSocket;

      // Browser received host_presence updates with both hosts online!
      const presenceMsgs = browserClient.sent
        .filter(m => m.startsWith("{"))
        .map(m => JSON.parse(m) as RealtimeEvent)
        .filter(m => m.type === "host_presence");
      expect(presenceMsgs.at(-1)?.hosts.map(x => x.hostId).sort()).toEqual(["hst_box02", "hst_mac01"]);

      // Upload page from MacBook Pro with opaque binding
      const opaque = JSON.stringify({
        v: 1,
        agent: { adapter: "claude", ref: "claude-mac-uuid-1" },
        cwd: "/Users/alice/report",
      });
      const upRes = await h.app(
        new Request(
          `${BASE_URL}/upload?name=mac-report&project=demo&task=multi&host_id=hst_mac01&host_name=MacBook%20Pro&binding=${encodeURIComponent(opaque)}`,
          {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "text/html" },
            body: "<h1>Mac Report v1</h1>",
          },
        ),
      );
      expect(upRes.status).toBe(201);
      const doc = (await upRes.json()) as { id: string };
      await h.flush();

      macClient.sent.length = 0;
      boxClient.sent.length = 0;

      // 1. Both daemons online: submit interaction -> targeted wake ONLY to hst_mac01; hst_box02 cannot claim!
      const int1Res = await h.app(
        new Request(`${BASE_URL}/api/archives/${doc.id}/interactions`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: "req-mac-1", prompt: "Add executive summary" }),
        }),
      );
      expect(int1Res.status).toBe(201);
      const int1Body = (await int1Res.json()) as any;
      expect(int1Body.hostPresence).toMatchObject({
        targetHostId: "hst_mac01",
        targetHostName: "MacBook Pro",
        targetHostOnline: true,
        onlineHostCount: 2,
      });
      await h.flush();

      // Verify ONLY macClient got daemon_wake, boxClient got NOTHING!
      expect(macClient.sent.some(m => m.includes('"daemon_wake"'))).toBe(true);
      expect(boxClient.sent.some(m => m.includes('"daemon_wake"'))).toBe(false);

      // hst_box02 attempts to claim -> 0 deliveries (anti-stealing!)
      const boxClaim1 = await (
        await h.app(
          new Request(`${BASE_URL}/api/daemon/claim`, {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ hostId: "hst_box02", hostName: "grok-bot-box" }),
          }),
        )
      ).json<any>();
      expect(boxClaim1.deliveries).toHaveLength(0);

      // hst_mac01 claims -> gets 1 delivery with opaqueBinding intact
      const macClaim1 = await (
        await h.app(
          new Request(`${BASE_URL}/api/daemon/claim`, {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ hostId: "hst_mac01", hostName: "MacBook Pro" }),
          }),
        )
      ).json<any>();
      expect(macClaim1.deliveries).toHaveLength(1);
      const env1 = macClaim1.deliveries[0];
      expect(env1.binding.hostId).toBe("hst_mac01");
      expect(env1.binding.opaqueBinding).toBe(opaque);

      // Lease renewal (/api/daemon/renew) works with valid fencingToken and returns 409 on stale token
      const renewOk = await h.app(
        new Request(`${BASE_URL}/api/daemon/renew`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            interactionId: env1.interactionId,
            fencingToken: env1.fencingToken,
            leaseSeconds: 120,
          }),
        }),
      );
      expect(renewOk.status).toBe(200);
      const renewStale = await h.app(
        new Request(`${BASE_URL}/api/daemon/renew`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            interactionId: env1.interactionId,
            fencingToken: "fence_stale",
          }),
        }),
      );
      expect(renewStale.status).toBe(409);

      // Complete turn 1
      const evRes1 = await h.app(
        new Request(`${BASE_URL}/api/daemon/events`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            interactionId: env1.interactionId,
            fencingToken: env1.fencingToken,
            eventKey: `${env1.deliveryId}:final:replied`,
            kind: "replied",
            displayAgent: "claude",
            replyText: "Added executive summary.",
          }),
        }),
      );
      expect(evRes1.status).toBe(200);
      await h.flush();

      // 2. Mac closes lid (disconnects) while Box stays online!
      h.eventsDo.webSocketClose(macServerSock as unknown as globalThis.WebSocket);
      const presenceAfterSleep = browserClient.sent
        .filter(m => m.startsWith("{"))
        .map(m => JSON.parse(m) as RealtimeEvent)
        .filter(m => m.type === "host_presence")
        .at(-1);
      expect(presenceAfterSleep?.hosts.map(x => x.hostId)).toEqual(["hst_box02"]);

      // Submit turn 2 while Mac is offline -> targetHostOnline === false, queued strictly for hst_mac01!
      const int2Res = await h.app(
        new Request(`${BASE_URL}/api/archives/${doc.id}/interactions`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: "req-mac-sleep", prompt: "Fix typo while on subway" }),
        }),
      );
      expect(int2Res.status).toBe(201);
      const int2Body = (await int2Res.json()) as any;
      expect(int2Body.hostPresence).toMatchObject({
        targetHostId: "hst_mac01",
        targetHostName: "MacBook Pro",
        targetHostOnline: false,
        onlineHostCount: 1,
      });
      await h.flush();

      // Box STILL cannot steal Mac's sleeping interaction!
      const boxClaimWhileSleeping = await (
        await h.app(
          new Request(`${BASE_URL}/api/daemon/claim`, {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ hostId: "hst_box02", hostName: "grok-bot-box" }),
          }),
        )
      ).json<any>();
      expect(boxClaimWhileSleeping.deliveries).toHaveLength(0);

      // 3. Explicit user handoff escape hatch (Decision 2 Option A): hand off to online hst_box02!
      boxClient.sent.length = 0;
      const handoffRes = await h.app(
        new Request(`${BASE_URL}/api/interactions/${int2Body.interaction.id}/handoff`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ targetHostId: "hst_box02" }),
        }),
      );
      expect(handoffRes.status).toBe(200);
      const handoffBody = (await handoffRes.json()) as any;
      expect(handoffBody.interaction.targetHostId).toBe("hst_box02");
      expect(handoffBody.hostPresence.targetHostOnline).toBe(true);
      await h.flush();

      // Box received daemon_wake and now claims with clean cross-host adhoc binding (no Mac /Users path)!
      expect(boxClient.sent.some(m => m.includes('"daemon_wake"'))).toBe(true);
      const boxClaimAfterHandoff = await (
        await h.app(
          new Request(`${BASE_URL}/api/daemon/claim`, {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ hostId: "hst_box02", hostName: "grok-bot-box" }),
          }),
        )
      ).json<any>();
      expect(boxClaimAfterHandoff.deliveries).toHaveLength(1);
      const handedEnv = boxClaimAfterHandoff.deliveries[0];
      expect(handedEnv.binding.hostId).toBe("hst_box02");
      expect(handedEnv.binding.sessionRef).toBe("adhoc");
      expect(handedEnv.binding.cwd).toBeNull();
      expect(handedEnv.binding.adapterMeta.handoffFromHostId).toBe("hst_mac01");

      // 4. Unbound static page -> discoveredBinding atomically pins session_bindings on first reply!
      const staticDoc = await (
        await h.app(
          new Request(`${BASE_URL}/upload?name=legacy-static&project=demo&task=multi`, {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "text/html" },
            body: "<h1>Legacy Static</h1>",
          }),
        )
      ).json<any>();
      await h.app(
        new Request(`${BASE_URL}/api/archives/${staticDoc.id}/interactions`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: "req-unbound-1", prompt: "Explain chart" }),
        }),
      );
      const boxUnboundClaim = await (
        await h.app(
          new Request(`${BASE_URL}/api/daemon/claim`, {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ hostId: "hst_box02", hostName: "grok-bot-box" }),
          }),
        )
      ).json<any>();
      expect(boxUnboundClaim.deliveries).toHaveLength(1);
      const uEnv = boxUnboundClaim.deliveries[0];
      await h.app(
        new Request(`${BASE_URL}/api/daemon/events`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            interactionId: uEnv.interactionId,
            fencingToken: uEnv.fencingToken,
            eventKey: `${uEnv.deliveryId}:final:replied`,
            kind: "replied",
            replyText: "Chart shows p99 latency.",
            discoveredBinding: {
              hostId: "hst_box02",
              hostName: "grok-bot-box",
              binding: JSON.stringify({ v: 1, agent: { adapter: "codex", ref: "th_99" } }),
            },
          }),
        }),
      );
      const bindingsRes = await (
        await h.app(
          new Request(`${BASE_URL}/api/archives/${staticDoc.id}/bindings`, {
            headers: authHeaders,
          }),
        )
      ).json<any>();
      expect(bindingsRes.bindings[0]).toMatchObject({
        hostId: "hst_box02",
        hostName: "grok-bot-box",
      });
    } finally {
      h.sqlite.close();
    }
  });

  it("Self-Hosted Node Runtime: matches Cloudflare DO presence, targeted daemon_wake, and anti-stealing 1:1", async () => {
    const nodeServer = await startNodePreviewServer({
      store: createMemoryObjectStore(),
      ALLOW_DEV_LOGIN: "true",
    });
    serversToClose.push(nodeServer);

    const loginRes = await fetch(`${nodeServer.url}/auth/dev-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "bob", issueDeviceToken: true }),
    });
    const { deviceToken, user } = (await loginRes.json()) as {
      deviceToken: string;
      user: { id: string };
    };
    const wsBase = nodeServer.url.replace(/^http:/, "ws:");

    const macFrames: string[] = [];
    const boxFrames: string[] = [];
    const browserFrames: string[] = [];

    const openWs = (path: string, sink: string[]) =>
      new Promise<WebSocket>((resolve, reject) => {
        const sock = new WebSocket(`${wsBase}${path}`, {
          headers: { Authorization: `Bearer ${deviceToken}` },
        });
        sock.on("message", d => {
          const str = String(d);
          sink.push(str);
          if (str === "connected") resolve(sock);
        });
        sock.on("error", reject);
      });

    const browserWs = await openWs("/api/events", browserFrames);
    const macWs = await openWs(
      "/api/events?role=daemon&host_id=hst_mac01&host_name=MacBook%20Pro",
      macFrames,
    );
    const boxWs = await openWs(
      "/api/events?role=daemon&host_id=hst_box02&host_name=grok-bot-box",
      boxFrames,
    );

    expect(nodeServer.getOnlineHosts(user.id).map(h => h.hostId).sort()).toEqual([
      "hst_box02",
      "hst_mac01",
    ]);

    const doc = await (
      await fetch(
        `${nodeServer.url}/upload?name=node-mac&project=p&task=t&host_id=hst_mac01&host_name=MacBook%20Pro`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${deviceToken}`, "Content-Type": "text/html" },
          body: "<h1>Node Mac v1</h1>",
        },
      )
    ).json<any>();

    macFrames.length = 0;
    boxFrames.length = 0;

    const created = await (
      await fetch(`${nodeServer.url}/api/archives/${doc.id}/interactions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deviceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: "Check Node routing" }),
      })
    ).json<any>();

    expect(created.hostPresence.targetHostId).toBe("hst_mac01");
    expect(created.hostPresence.targetHostOnline).toBe(true);

    // Wait briefly for async deferred wake notification
    await new Promise(r => setTimeout(r, 40));
    expect(macFrames.some(f => f.includes('"daemon_wake"'))).toBe(true);
    expect(boxFrames.some(f => f.includes('"daemon_wake"'))).toBe(false);

    // Box cannot steal
    const boxClaim = await (
      await fetch(`${nodeServer.url}/api/daemon/claim`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deviceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ hostId: "hst_box02" }),
      })
    ).json<any>();
    expect(boxClaim.deliveries).toHaveLength(0);

    browserWs.close();
    macWs.close();
    boxWs.close();
  });
});
