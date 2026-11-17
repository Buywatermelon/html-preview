import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { HtmlPreviewEvents } from "../src/events";
import { applyMigrations } from "../src/node-db";
import type { Credential } from "../src/auth";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  applyMigrations(db);
  db.exec(`
    INSERT INTO users(id, github_id, login, created_at)
    VALUES ('u1', '101', 'alice', '2026-11-09T00:00:00Z');

    INSERT INTO auth_sessions(id, user_id, token_hash, user_agent, created_at, expires_at, last_seen_at)
    VALUES
      ('s-ok', 'u1', 'sess-active', 'Mozilla/5.0', '2026-11-09T00:00:00Z', '2099-01-01T00:00:00Z', '2026-11-09T00:00:00Z'),
      ('s-exp', 'u1', 'sess-expired', 'Mozilla/5.0', '2026-11-09T00:00:00Z', '2000-01-01T00:00:00Z', '2026-11-09T00:00:00Z');

    INSERT INTO device_tokens(id, user_id, name, token_hash, token_prefix, created_at, last_used_at, revoked_at)
    VALUES
      ('t-ok', 'u1', 'CLI 1', 'tok-active', 'hpd_active…', '2026-11-09T00:00:00Z', NULL, NULL),
      ('t-rev', 'u1', 'CLI 2', 'tok-revoked', 'hpd_revoke…', '2026-11-09T00:00:00Z', NULL, '2026-11-09T01:00:00Z');
  `);
  vi.stubGlobal("WebSocketRequestResponsePair", class {});
});

afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

function harness() {
  const creds: Array<Credential | undefined> = [
    { kind: "session", hash: "sess-active" },
    { kind: "device_token", hash: "tok-active" },
    { kind: "session", hash: "sess-expired" },
    { kind: "device_token", hash: "tok-revoked" },
    { kind: "device_token", hash: "tok-missing" },
  ];
  const sockets = creds.map(cred => ({
    deserializeAttachment: () => cred,
    send: vi.fn(),
    close: vi.fn(),
  }));
  const binding = {
    prepare: (sql: string) => ({
      bind: (...values: any[]) => ({
        all: async () => ({ results: db.prepare(sql).all(...values) }),
      }),
    }),
  };
  const events = new HtmlPreviewEvents(
    { setWebSocketAutoResponse() {}, getWebSockets: () => sockets } as unknown as DurableObjectState,
    { DB: binding as unknown as D1Database },
  );
  return { events, sockets };
}

it("broadcasts only while each socket session or device_token credential is still valid", async () => {
  const { events, sockets } = harness();
  const payload = JSON.stringify({ type: "upload", version: 1 });
  expect(
    (await events.fetch(new Request("https://events/changed", { method: "POST", body: payload }))).status,
  ).toBe(204);
  expect(sockets[0].send.mock.calls.map(c => c[0])).toEqual(["changed", payload]);
  expect(sockets[1].send.mock.calls.map(c => c[0])).toEqual(["changed", payload]);
  for (const socket of sockets.slice(2)) {
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(1008, "Session changed");
  }
});

it("revalidates sockets on single-token/session logout without dropping other valid devices", async () => {
  const { events, sockets } = harness();
  const res = await events.fetch(new Request("https://events/revalidate", { method: "POST" }));
  expect(res.status).toBe(204);
  expect(sockets[0].close).not.toHaveBeenCalled();
  expect(sockets[1].close).not.toHaveBeenCalled();
  for (const socket of sockets.slice(2)) {
    expect(socket.close).toHaveBeenCalledWith(1008, "Session changed");
  }
});

