import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createApp, type ChangeEvent } from "../src/app";
import { injectSidebarBridge } from "../src/sidebar-bridge";
import { applyMigrations, sqliteDatabase } from "../src/node-db";
import { hash, Auth, type AuthConfig } from "../src/auth";
import { S3Store } from "../src/storage";
import { zipSync, strToU8 } from "fflate";

const base = "https://preview.example";
const defaultConfig: AuthConfig = {
  PUBLIC_BASE_URL: base,
  GITHUB_CLIENT_ID: "test-client",
  GITHUB_CLIENT_SECRET: "test-secret",
  ADMIN_GITHUB_LOGIN: "alice",
};

let sqlite: DatabaseSync;

function createMemoryStore(objects: Map<string, Uint8Array>) {
  const store = {
    failPut: false,
    failGet: false,
    failDelete: false,
    async put(key: string, data: Uint8Array) {
      if (store.failPut) throw Error("storage outage");
      objects.set(key, data.slice());
    },
    async get(key: string) {
      if (store.failGet) throw Error("storage outage");
      const data = objects.get(key);
      return data ? new Response(data.slice()) : null;
    },
    async delete(key: string) {
      if (store.failDelete) throw Error("storage outage");
      objects.delete(key);
    },
  };
  return store;
}

function harness(overrides: Partial<AuthConfig> = {}) {
  sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const cfg: AuthConfig = { ...defaultConfig, ...overrides };
  const db = sqliteDatabase(sqlite);
  const objects = new Map<string, Uint8Array>();
  const pending: Promise<unknown>[] = [];
  const changes: Array<{ users: string[]; event?: ChangeEvent }> = [];
  const disconnected: string[] = [];

  const store = createMemoryStore(objects);
  const auth = new Auth(db, cfg);
  const app = createApp({
    ...cfg,
    db,
    store,
    defer: p => pending.push(p),
    async disconnect(id) {
      disconnected.push(id);
    },
    async notify(users, event) {
      changes.push({ users, event });
    },
  });

  const request = (path: string, user = "alice", init: RequestInit = {}) =>
    app(
      new Request(base + path, {
        ...init,
        headers: {
          ...(user ? { Authorization: "Bearer " + user } : {}),
          ...Object.fromEntries(new Headers(init.headers)),
        },
      }),
    );
  const send = (path: string, data: unknown, user = "alice", method = "POST") =>
    request(path, user, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  const upload = (source = "<body>one</body>", user = "alice", name = "page", extraQuery = "") =>
    request(`/upload?name=${name}&project=项目&task=任务${extraQuery}`, user, {
      method: "POST",
      headers: { "Content-Type": "text/html" },
      body: source,
    });

  return {
    app,
    sqlite,
    db,
    store,
    objects,
    changes,
    pending,
    request,
    send,
    upload,
    auth,
    disconnected,
  };
}

let h: ReturnType<typeof harness>;

async function mintToken(
  target: ReturnType<typeof harness>,
  userId: string,
  rawToken: string,
  name = "Test CLI",
) {
  const id = crypto.randomUUID();
  await target.db.batch([
    {
      sql: "INSERT INTO device_tokens(id, user_id, name, token_hash, token_prefix, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, '2026-11-08T00:00:00Z', NULL, NULL)",
      values: [id, userId, name, await hash(rawToken), `${rawToken.slice(0, 10)}…`],
    },
  ]);
  return id;
}

async function seedDefaultUsers(target = h) {
  await target.db.batch([
    {
      sql: "INSERT INTO users(id, github_id, login, created_at) VALUES ('alice', '1', 'alice', '2026-11-08T00:00:00Z'), ('bob', '2', 'bob', '2026-11-08T00:00:00Z')",
      values: [],
    },
  ]);
  await mintToken(target, "alice", "alice", "Alice CLI");
  await mintToken(target, "bob", "bob", "Bob CLI");
}

beforeEach(async () => {
  h = harness();
  await seedDefaultUsers(h);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(h.pending);
  sqlite.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const data = async (response: Response) => {
  expect(response.status).toBeLessThan(300);
  return response.json<any>();
};
const raw = (url: string) => new URL(url).pathname;

describe("migrations and schema cleanup", () => {
  it("initializes fresh databases via 0001_init.sql and losslessly aligns existing legacy self-hosted databases", () => {
    // 1. Fresh database initialized from squashed 0001_init.sql
    const fresh = new DatabaseSync(":memory:");
    try {
      applyMigrations(fresh);
      applyMigrations(fresh); // idempotent
      const freshApplied = fresh
        .prepare("SELECT name FROM _migrations ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(freshApplied.map(r => r.name)).toEqual(["0001_init.sql", "0002_page_tombstones.sql"]);
    } finally {
      fresh.close();
    }

    // 2. Legacy 0001.sql self-hosted database upgrades & aligns to 0001_init.sql with zero personal data loss
    const legacy = new DatabaseSync(":memory:");
    try {
      legacy.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          github_id TEXT UNIQUE,
          login TEXT NOT NULL UNIQUE COLLATE NOCASE,
          key_hash TEXT NOT NULL UNIQUE,
          key_cipher TEXT NOT NULL,
          key_prefix TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          invite_code TEXT NOT NULL UNIQUE,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE workspace_members (
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          joined_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id, user_id)
        );
        CREATE TABLE oauth_states (
          state TEXT PRIMARY KEY,
          verifier TEXT NOT NULL,
          invite_code TEXT,
          next TEXT,
          expires_at TEXT NOT NULL
        );
        CREATE TABLE documents (
          id TEXT PRIMARY KEY,
          public_id TEXT NOT NULL UNIQUE,
          scope TEXT NOT NULL,
          name TEXT NOT NULL,
          title TEXT NOT NULL,
          folder TEXT NOT NULL,
          sort_order INTEGER DEFAULT NULL,
          created_at TEXT NOT NULL,
          published_from TEXT UNIQUE,
          deleting INTEGER NOT NULL DEFAULT 0,
          UNIQUE(scope, name)
        );
        CREATE TABLE versions (
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          storage_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          note TEXT NOT NULL,
          files TEXT NOT NULL,
          total_bytes INTEGER NOT NULL,
          source_version INTEGER,
          PRIMARY KEY(document_id, version),
          UNIQUE(document_id, source_version)
        );

        INSERT INTO users(id, github_id, login, key_hash, key_cipher, key_prefix, created_at)
        VALUES
          ('alice', '101', 'alice', 'hash_a', 'cipher_a', 'hp_a…', '2026-11-08T00:00:00Z'),
          ('owner', NULL, 'bootstrap-owner', 'hash_o', 'cipher_o', 'hp_o…', '2026-11-08T00:00:00Z'),
          ('blank', '   ', 'blank-gh', 'hash_b', 'cipher_b', 'hp_b…', '2026-11-08T00:00:00Z');

        INSERT INTO documents(id, public_id, scope, name, title, folder, created_at)
        VALUES
          ('personal-1', 'personal-1-pub', 'alice', 'p1', 'Personal', 'uncategorized', '2026-11-08T00:00:00Z'),
          ('team-1', 'team-1-pub', 'team', 't1', 'Team', 'uncategorized', '2026-11-08T00:00:00Z');
        INSERT INTO versions(document_id, version, storage_id, created_at, note, files, total_bytes)
        VALUES
          ('personal-1', 1, 'sites/p1/', '2026-11-08T00:00:00Z', '', '["index.html"]', 10),
          ('team-1', 1, 'sites/t1/', '2026-11-08T00:00:00Z', '', '["index.html"]', 10);
        CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO _migrations VALUES ('0001.sql', '2026-11-08T00:00:00Z');
      `);

      applyMigrations(legacy);
      legacy.exec(
        "INSERT INTO oauth_states(state, verifier, next, expires_at) VALUES ('s1', 'v1', '/dashboard', '2099-01-01T00:00:00Z')",
      );
      applyMigrations(legacy);

      const applied = legacy.prepare("SELECT name FROM _migrations ORDER BY name").all() as Array<{
        name: string;
      }>;
      expect(applied.map(r => r.name)).toEqual(["0001_init.sql", "0002_page_tombstones.sql"]);

      const indexes = (
        legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
          name: string;
        }>
      ).map(r => r.name);
      expect(indexes).toContain("documents_share_token");
      expect(indexes).toContain("auth_sessions_user_id");
      expect(indexes).toContain("auth_sessions_expires_at");
      expect(indexes).toContain("device_tokens_user_created");
      expect(indexes).toContain("device_codes_expires_at");
      expect(indexes).toContain("idx_deliveries_host_claim");

      const bindingCols = (
        legacy.prepare("PRAGMA table_info(session_bindings)").all() as Array<{ name: string }>
      ).map(c => c.name);
      expect(bindingCols).toEqual(
        expect.arrayContaining(["host_id", "host_name", "opaque_binding"]),
      );
      const deliveryCols = (
        legacy.prepare("PRAGMA table_info(interaction_deliveries)").all() as Array<{ name: string }>
      ).map(c => c.name);
      expect(deliveryCols).toContain("target_host_id");

      const tables = (
        legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map(r => r.name);
      expect(tables).not.toContain("workspaces");
      expect(tables).not.toContain("workspace_members");
      expect(tables).toContain("auth_sessions");
      expect(tables).toContain("device_tokens");
      expect(tables).toContain("device_codes");

      const userCols = (
        legacy.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>
      ).map(c => c.name);
      expect(userCols).toEqual(["id", "github_id", "login", "created_at"]);

      const migratedUsers = legacy.prepare("SELECT * FROM users").all();
      expect(migratedUsers).toEqual([
        {
          id: "alice",
          github_id: "101",
          login: "alice",
          created_at: "2026-11-08T00:00:00Z",
        },
      ]);

      const docs = legacy.prepare("SELECT id FROM documents").all() as Array<{ id: string }>;
      expect(docs).toEqual([{ id: "personal-1" }]);
      const versions = legacy.prepare("SELECT document_id FROM versions").all() as Array<{
        document_id: string;
      }>;
      expect(versions).toEqual([{ document_id: "personal-1" }]);
      const states = legacy.prepare("SELECT state FROM oauth_states").all() as Array<{
        state: string;
      }>;
      expect(states).toEqual([{ state: "s1" }]);
    } finally {
      legacy.close();
    }

    // 3. Existing 0001..0005 self-hosted DB (matching pre-0006 production state) adds daemon routing columns without losing rows
    const pre0006 = new DatabaseSync(":memory:");
    try {
      pre0006.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE users (id TEXT PRIMARY KEY, github_id TEXT NOT NULL UNIQUE, login TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT NOT NULL);
        CREATE TABLE documents (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, name TEXT NOT NULL, title TEXT NOT NULL, folder TEXT NOT NULL, sort_order INTEGER DEFAULT NULL, created_at TEXT NOT NULL, published_from TEXT UNIQUE, deleting INTEGER NOT NULL DEFAULT 0, share_token TEXT, shared_at TEXT, UNIQUE(scope, name));
        CREATE TABLE session_bindings (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, version INTEGER NOT NULL, adapter_id TEXT NOT NULL, fallback_adapter_id TEXT, session_ref TEXT NOT NULL, cwd TEXT, source_file TEXT, adapter_meta_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, UNIQUE (document_id, version));
        CREATE TABLE interactions (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_index INTEGER NOT NULL DEFAULT 1, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, base_version INTEGER NOT NULL, request_id TEXT NOT NULL, anchor_json TEXT, intent TEXT NOT NULL, prompt TEXT NOT NULL, target_adapter_id TEXT NOT NULL, effective_adapter_id TEXT, auto_fallback_from TEXT, status TEXT NOT NULL, progress_text TEXT, reply_text TEXT, result_version INTEGER, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (owner_id, request_id));
        CREATE TABLE interaction_deliveries (id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL REFERENCES interactions(id) ON DELETE CASCADE, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, adapter_id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, lease_owner TEXT, lease_until TEXT, fencing_token TEXT, receipt_json TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (interaction_id));
        INSERT INTO users VALUES ('u1', 'gh1', 'alice', '2026-11-13T00:00:00Z');
        INSERT INTO documents(id, public_id, scope, name, title, folder, created_at) VALUES ('d1', 'pub1', 'u1', 'doc1', 'Doc 1', 'f', '2026-11-13T00:00:00Z');
        INSERT INTO interactions(id, thread_id, turn_index, owner_id, document_id, base_version, request_id, intent, prompt, target_adapter_id, status, created_at, updated_at) VALUES ('int1', 'th1', 1, 'u1', 'd1', 1, 'req1', 'question', 'hi', 'claude', 'replied', '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z');
        INSERT INTO interaction_deliveries(id, interaction_id, owner_id, adapter_id, attempt, state, created_at, updated_at) VALUES ('dlv1', 'int1', 'u1', 'claude', 1, 'replied', '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z');
        CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO _migrations VALUES
          ('0001.sql', '2026-11-07T00:00:00Z'),
          ('0002_drop_team.sql', '2026-11-13T00:00:00Z'),
          ('0003_public_share.sql', '2026-11-13T00:00:00Z'),
          ('0004_github_device_auth.sql', '2026-11-13T00:00:00Z'),
          ('0005_interactions.sql', '2026-11-13T00:00:00Z');
      `);
      applyMigrations(pre0006);
      const migs = pre0006.prepare("SELECT name FROM _migrations").all() as Array<{ name: string }>;
      expect(migs).toEqual([{ name: "0001_init.sql" }, { name: "0002_page_tombstones.sql" }]);
      const keptInt = pre0006
        .prepare("SELECT id, target_host_id FROM interactions WHERE id = 'int1'")
        .get() as { id: string; target_host_id: string | null };
      expect(keptInt).toEqual({ id: "int1", target_host_id: null });
    } finally {
      pre0006.close();
    }
  });
});

describe("personal documents, dynamic folders, title order, and ZIP/S3 serving", () => {
  it("isolates personal catalog, previews, mutations and notifications by member", async () => {
    const first = await data(await h.upload());
    expect(first.scope).toBeUndefined();
    await Promise.all(h.pending);

    const aliceCatalog = await data(await h.request("/api/catalog", "alice"));
    expect(aliceCatalog.user).toEqual({ id: "alice", login: "alice" });
    expect(aliceCatalog.archives).toHaveLength(1);
    expect(aliceCatalog.archives[0].scope).toBeUndefined();
    expect(aliceCatalog.archives[0].publishedFrom).toBeUndefined();
    expect(aliceCatalog.archives[0].expired).toBeUndefined();

    expect((await data(await h.request("/api/catalog", "bob"))).archives).toEqual([]);
    expect((await h.request(raw(first.url), "bob")).status).toBe(404);
    expect((await h.send("/api/archives/" + first.id, { title: "stolen" }, "bob", "PATCH")).status).toBe(404);
    expect((await h.request("/api/archives/" + first.id, "bob", { method: "DELETE" })).status).toBe(404);
    expect(h.changes[0].users).toEqual(["alice"]);
    expect(h.changes[0].event?.versionUrl).toBe(first.versionUrl);
    expect((h.changes[0].event as any)?.scope).toBeUndefined();
    expect((await h.request("/api/catalog", "")).status).toBe(401);
    expect((await h.request(raw(first.url), "")).status).toBe(302);
  });

  it("derives projects/tasks dynamically from live documents with zero empty folders", async () => {
    const doc = await data(await h.upload("<body>hello</body>", "alice", "doc1"));
    let cat = await data(await h.request("/api/catalog", "alice"));
    expect(cat.projects).toEqual([{ name: "项目", createdAt: expect.any(String), tasks: ["任务"] }]);

    await data(await h.send("/api/archives/" + doc.id, { folder: "新项目/新任务" }, "alice", "PATCH"));
    cat = await data(await h.request("/api/catalog", "alice"));
    expect(cat.projects).toEqual([{ name: "新项目", createdAt: expect.any(String), tasks: ["新任务"] }]);

    await data(await h.request("/api/archives/" + doc.id, "alice", { method: "DELETE" }));
    cat = await data(await h.request("/api/catalog", "alice"));
    expect(cat.projects).toEqual([]);
    expect(h.objects.size).toBe(0);
  });

  it("sorts 01, 02, and 10 by title even when sort_order is set", async () => {
    const ten = await data(
      await h.upload("<body>a</body>", "alice", "doc-10", "&title=" + encodeURIComponent("10章")),
    );
    const two = await data(
      await h.upload("<body>b</body>", "alice", "doc-02", "&title=" + encodeURIComponent("02章")),
    );
    await data(
      await h.upload("<body>c</body>", "alice", "doc-01", "&title=" + encodeURIComponent("01章")),
    );
    await h.db.batch([
      { sql: "UPDATE documents SET sort_order = 0 WHERE id = ?", values: [ten.id] },
      { sql: "UPDATE documents SET sort_order = 1 WHERE id = ?", values: [two.id] },
    ]);

    const cat = await data(await h.request("/api/catalog", "alice"));
    expect(cat.archives.map((a: any) => a.title)).toEqual(["01章", "02章", "10章"]);
    expect(cat.archives.every((a: any) => a.sortOrder === undefined)).toBe(true);

    await data(await h.send("/api/archives/" + ten.id, { sortOrder: 1 }, "alice", "PATCH"));
    const again = await data(await h.request("/api/catalog", "alice"));
    expect(again.archives.map((a: any) => a.title)).toEqual(["01章", "02章", "10章"]);
  });

  it("serves raw HTML without an injected version bar", async () => {
    const html = "<!doctype html><html><body><h1>Clean Page</h1></body></html>";
    const first = await data(await h.upload(html, "alice", "clean"));
    expect(first.sortOrder).toBeUndefined();
    const body = await (await h.request(raw(first.url))).text();
    expect(body).toBe(await injectSidebarBridge(html));
    expect(body).not.toContain("html-preview-version-bar");
  });

  it("allocates sequential versions for concurrent uploads", async () => {
    const results = await Promise.all([h.upload("A"), h.upload("B")]);
    const values = await Promise.all(results.map(data));
    expect(values.map(v => v.version).sort()).toEqual([1, 2]);
    expect(new Set(values.map(v => v.id)).size).toBe(1);
    expect(await (await h.request(raw(values[0].versionUrl))).text()).toBe(
      await injectSidebarBridge("A"),
    );
    expect(await (await h.request(raw(values[1].versionUrl))).text()).toBe(
      await injectSidebarBridge("B"),
    );
  });

  it("serves ZIP assets and nested indexes through the application", async () => {
    const zip = zipSync({
      "index.html": strToU8("home"),
      "assets/样式.css": strToU8("body{}"),
      "docs/index.html": strToU8("nested"),
    });
    const first = await data(
      await h.request("/upload?name=site", "alice", {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: zip,
      }),
    );
    expect(
      await (
        await h.request(new URL(first.url).pathname + "assets/" + encodeURIComponent("样式.css"))
      ).text(),
    ).toBe("body{}");
    const redirect = await h.request(new URL(first.url).pathname + "docs");
    expect(redirect.status).toBe(308);
    expect(await (await h.request(new URL(first.url).pathname + "docs/")).text()).toBe(
      await injectSidebarBridge("nested"),
    );
  });

  it("builds virtual-hosted and path-style S3 URLs", async () => {
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any, init: any) => {
        const req = new Request(input, init);
        calls.push(req);
        return new Response(req.method === "GET" ? "ok" : null, {
          status: req.method === "DELETE" ? 204 : 200,
        });
      }),
    );

    const virtualStore = new S3Store({
      S3_ENDPOINT: "https://s3.example.com",
      S3_BUCKET: "example-bucket",
      S3_REGION: "auto",
      S3_ACCESS_KEY_ID: "ak",
      S3_SECRET_ACCESS_KEY: "sk",
      pathStyle: false,
    });
    await virtualStore.put("sites/1/index.html", strToU8("hi"), "text/html");
    expect(calls[0].url).toBe("https://example-bucket.s3.example.com/sites/1/index.html");

    const pathStore = new S3Store({
      S3_ENDPOINT: "https://s3.example.com",
      S3_BUCKET: "example-bucket",
      S3_REGION: "auto",
      S3_ACCESS_KEY_ID: "ak",
      S3_SECRET_ACCESS_KEY: "sk",
      pathStyle: true,
    });
    await pathStore.put("sites/1/index.html", strToU8("hi"), "text/html");
    expect(calls[1].url).toBe("https://s3.example.com/example-bucket/sites/1/index.html");

    const defaultStore = new S3Store({
      S3_ENDPOINT: "https://s3.example.com",
      S3_BUCKET: "example-bucket",
      S3_REGION: "auto",
      S3_ACCESS_KEY_ID: "ak",
      S3_SECRET_ACCESS_KEY: "sk",
    });
    await defaultStore.put("sites/1/index.html", strToU8("hi"), "text/html");
    expect(calls[2].url).toBe("https://s3.example.com/example-bucket/sites/1/index.html");
  });
});

describe("GitHub OAuth browser sessions, RFC 8628 Device Flow, device_tokens, and dev login", () => {
  it("sets opaque hp_session cookie on GitHub OAuth, exposes zero persistent keys on /api/session, and invalidates on DELETE /api/session", async () => {
    expect(await h.auth.sessionPayload()).toEqual({ authenticated: false, user: null });
    expect((await h.request("/api/session", "")).status).toBe(401);
    expect((await h.request("/api/session", "not-a-member")).status).toBe(401);

    // Legacy POST /api/session login no longer exists -> 405 (with valid Origin) or 403 (without Origin)
    expect((await h.send("/api/session", { key: "alice" }, "")).status).toBe(403);
    expect(
      (
        await h.request("/api/session", "", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: base },
          body: JSON.stringify({ key: "alice" }),
        })
      ).status,
    ).toBe(405);

    sqlite.close();
    h = harness({ ADMIN_GITHUB_LOGIN: "alice" });

    // 1. Stranger attempts OAuth when ADMIN_GITHUB_LOGIN is set -> rejected
    const startStranger = await h.request("/auth/login", "");
    const strangerState = new URL(startStranger.headers.get("Location")!).searchParams.get("state")!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) =>
        String(url).includes("access_token")
          ? Response.json({ access_token: "gh_tok" })
          : Response.json({ id: 999, login: "stranger" }),
      ),
    );
    const strangerCallback = await h.request(
      `/auth/callback?state=${strangerState}&code=code_stranger`,
      "",
      { headers: { Cookie: `hp_oauth=${strangerState}` } },
    );
    expect(strangerCallback.status).toBe(302);
    expect(strangerCallback.headers.get("Location")).toBe("/dashboard?auth_error=unauthorized");
    expect(strangerCallback.headers.getSetCookie().some(c => c.startsWith("hp_session="))).toBe(false);
    expect(strangerCallback.headers.getSetCookie().some(c => c.startsWith("hp_key="))).toBe(false);
    expect(strangerCallback.headers.getSetCookie().some(c => c.startsWith("hp_oauth=;"))).toBe(true);
    expect(await h.db.all("SELECT * FROM users")).toEqual([]);

    // 2. Admin 'alice' logs in via GitHub OAuth with ?device_code=... in next -> sets opaque hp_session cookie
    const startAdmin = await h.request(
      "/auth/login?next=" + encodeURIComponent("/dashboard?device_code=ABCD-2345"),
      "",
    );
    expect(startAdmin.status).toBe(302);
    const adminState = new URL(startAdmin.headers.get("Location")!).searchParams.get("state")!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) =>
        String(url).includes("access_token")
          ? Response.json({ access_token: "gh_tok" })
          : Response.json({ id: 101, login: "Alice" }),
      ),
    );
    const adminCallback = await h.request(`/auth/callback?state=${adminState}&code=code_admin`, "", {
      headers: { Cookie: `hp_oauth=${adminState}`, "User-Agent": "PlaywrightTest/1.0" },
    });
    expect(adminCallback.status).toBe(302);
    expect(adminCallback.headers.get("Location")).toBe("/dashboard?device_code=ABCD-2345");
    expect(adminCallback.headers.getSetCookie().some(c => c.startsWith("hp_key="))).toBe(false);
    const sessionCookie = adminCallback.headers.getSetCookie().find(c => c.startsWith("hp_session="))!;
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Lax");
    expect(sessionCookie).toContain("Max-Age=2592000");
    expect(sessionCookie).toContain("Secure");
    const rawSession = sessionCookie.split(";")[0].split("=")[1];
    expect(rawSession).toMatch(/^hps_[0-9a-f]{64}$/);

    // Opaque session token is NOT a Bearer device_token (Bearer hps_... must fail)
    expect((await h.request("/api/session", rawSession)).status).toBe(401);
    // Legacy hp_key cookie is completely ignored
    expect(
      (await h.request("/api/session", "", { headers: { Cookie: `hp_key=${rawSession}` } })).status,
    ).toBe(401);

    // GET /api/session with hp_session cookie returns user without any key or keyPrefix!
    const sessionRes = await h.request("/api/session", "", {
      headers: { Cookie: `hp_session=${rawSession}` },
    });
    const sessionBody = await data(sessionRes);
    expect(sessionBody).toEqual({
      authenticated: true,
      user: {
        id: expect.any(String),
        login: "alice",
        github_id: "101",
        avatarUrl: "https://avatars.githubusercontent.com/u/101?v=4&s=80",
      },
    });
    expect(sessionBody.user.key).toBeUndefined();
    expect(sessionBody.user.keyPrefix).toBeUndefined();

    // 3. Existing non-admin user 'bob' in users table can sign in via GitHub OAuth and updates login
    await h.db.batch([
      {
        sql: "INSERT INTO users(id, github_id, login, created_at) VALUES ('bob', '202', 'bob', '2026-11-08T00:00:00Z')",
        values: [],
      },
    ]);
    const startBob = await h.request("/auth/login", "");
    const bobState = new URL(startBob.headers.get("Location")!).searchParams.get("state")!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) =>
        String(url).includes("access_token")
          ? Response.json({ access_token: "gh_tok" })
          : Response.json({ id: 202, login: "bob-renamed" }),
      ),
    );
    const bobCallback = await h.request(`/auth/callback?state=${bobState}&code=code_bob`, "", {
      headers: { Cookie: `hp_oauth=${bobState}` },
    });
    expect(bobCallback.status).toBe(302);
    const bobCookie = bobCallback.headers.getSetCookie().find(c => c.startsWith("hp_session="))!;
    const bobSessionVal = bobCookie.split(";")[0].split("=")[1];
    const bobSession = await data(
      await h.request("/api/session", "", { headers: { Cookie: `hp_session=${bobSessionVal}` } }),
    );
    expect(bobSession.user.login).toBe("bob-renamed");

    // 4. DELETE /api/session deletes the auth_sessions row, disconnects sockets, and invalidates cookie
    const logoutRes = await h.request("/api/session", "", {
      method: "DELETE",
      headers: { Cookie: `hp_session=${rawSession}`, Origin: base },
    });
    expect(logoutRes.status).toBe(204);
    expect(logoutRes.headers.get("Set-Cookie")).toContain("hp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    expect(h.disconnected).toContain(sessionBody.user.id);

    // Reusing rawSession cookie after logout immediately returns 401 while bob's session remains active
    expect(
      (await h.request("/api/session", "", { headers: { Cookie: `hp_session=${rawSession}` } })).status,
    ).toBe(401);
    expect(
      (await h.request("/api/session", "", { headers: { Cookie: `hp_session=${bobSessionVal}` } })).status,
    ).toBe(200);
  });

  it("allows first user via OAuth when no admin login is configured and rejects second unknown user", async () => {
    sqlite.close();
    h = harness({ ADMIN_GITHUB_LOGIN: undefined, BOOTSTRAP_GITHUB_LOGIN: undefined });

    const startFirst = await h.request("/auth/login", "");
    const firstState = new URL(startFirst.headers.get("Location")!).searchParams.get("state")!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) =>
        String(url).includes("access_token")
          ? Response.json({ access_token: "gh_tok" })
          : Response.json({ id: 1, login: "pioneer" }),
      ),
    );
    const firstCb = await h.request(`/auth/callback?state=${firstState}&code=c1`, "", {
      headers: { Cookie: `hp_oauth=${firstState}` },
    });
    expect(firstCb.status).toBe(302);
    expect(firstCb.headers.get("Location")).toBe("/dashboard");

    const startSecond = await h.request("/auth/login", "");
    const secondState = new URL(startSecond.headers.get("Location")!).searchParams.get("state")!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) =>
        String(url).includes("access_token")
          ? Response.json({ access_token: "gh_tok" })
          : Response.json({ id: 2, login: "intruder" }),
      ),
    );
    const secondCb = await h.request(`/auth/callback?state=${secondState}&code=c2`, "", {
      headers: { Cookie: `hp_oauth=${secondState}` },
    });
    expect(secondCb.status).toBe(302);
    expect(secondCb.headers.get("Location")).toBe("/dashboard?auth_error=unauthorized");
  });

  it("completes RFC 8628 Device Code Flow end-to-end, enforces single consumption, and handles deny/expiry", async () => {
    const aliceSession = await h.auth.createSession("alice", "Browser");

    // 1. Unauthenticated CLI requests a device code (no Origin, no Authorization)
    const codeRes = await h.request("/auth/device/code", "", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Alice MacBook CLI" }),
    });
    expect(codeRes.status).toBe(200);
    const codeBody = await codeRes.json<any>();
    expect(codeBody).toEqual({
      device_code: expect.stringMatching(/^[0-9a-f]{64}$/),
      user_code: expect.stringMatching(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/),
      verification_uri: `${base}/dashboard`,
      verification_uri_complete: `${base}/dashboard?device_code=${codeBody.user_code}`,
      expires_in: 600,
      interval: 2,
    });

    // 2. CLI polls before approval -> 400 authorization_pending (supports x-www-form-urlencoded too)
    const pendingRes = await h.request("/auth/device/token", "", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: codeBody.device_code,
      }),
    });
    expect(pendingRes.status).toBe(400);
    expect(await pendingRes.json()).toEqual({ error: "authorization_pending" });

    // 3. Browser inspects pending user_code (normalizing lowercase + missing hyphen)
    expect((await h.request(`/api/auth/device?user_code=${codeBody.user_code}`, "")).status).toBe(401);
    const normalizedInput = codeBody.user_code.replace("-", " ").toLowerCase();
    const inspectRes = await h.request(
      `/api/auth/device?user_code=${encodeURIComponent(normalizedInput)}`,
      "",
      { headers: { Cookie: `hp_session=${aliceSession.rawToken}` } },
    );
    expect(await data(inspectRes)).toEqual({
      userCode: codeBody.user_code,
      clientName: "Alice MacBook CLI",
      status: "pending",
      expiresAt: expect.any(String),
    });

    // Browser POST /api/auth/device/approve requires Origin (CSRF protection)
    expect(
      (
        await h.request("/api/auth/device/approve", "", {
          method: "POST",
          headers: {
            Cookie: `hp_session=${aliceSession.rawToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ user_code: normalizedInput }),
        })
      ).status,
    ).toBe(403);

    // 4. Browser approves device code
    const approveRes = await h.request("/api/auth/device/approve", "", {
      method: "POST",
      headers: {
        Cookie: `hp_session=${aliceSession.rawToken}`,
        Origin: base,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_code: normalizedInput,
        action: "approve",
        client_name: "Workstation CLI",
      }),
    });
    expect(await data(approveRes)).toEqual({ ok: true, status: "approved" });

    // Approving an already-approved code returns 409
    const dupApprove = await h.request("/api/auth/device/approve", "", {
      method: "POST",
      headers: {
        Cookie: `hp_session=${aliceSession.rawToken}`,
        Origin: base,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_code: codeBody.user_code }),
    });
    expect(dupApprove.status).toBe(409);

    // Verify plaintext token is NEVER stored in device_codes
    const dbDeviceCols = (
      sqlite.prepare("PRAGMA table_info(device_codes)").all() as Array<{ name: string }>
    ).map(c => c.name);
    expect(dbDeviceCols).not.toContain("token");
    expect(dbDeviceCols).not.toContain("access_token");

    // 5. CLI polls /auth/device/token and receives plaintext hpd_... token ONCE
    const tokRes = await h.request("/auth/device/token", "", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: codeBody.device_code }),
    });
    expect(tokRes.status).toBe(200);
    const tokBody = await tokRes.json<any>();
    expect(tokBody).toEqual({
      access_token: expect.stringMatching(/^hpd_[0-9a-f]{48}$/),
      token_type: "Bearer",
      token_id: expect.any(String),
      token_prefix: `${tokBody.access_token.slice(0, 10)}…`,
      user: { id: "alice", login: "alice" },
    });

    // Replay of consumed device_code immediately fails with 400 invalid_grant
    const replayRes = await h.request("/auth/device/token", "", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: codeBody.device_code }),
    });
    expect(replayRes.status).toBe(400);
    expect(await replayRes.json()).toEqual({ error: "invalid_grant" });

    // Minted hpd_... token authenticates CLI uploads and catalog access
    const uploaded = await data(await h.upload("<body>from-cli</body>", tokBody.access_token, "cli-doc"));
    expect(uploaded.version).toBe(1);

    // 6. Deny flow -> access_denied, Expired flow -> expired_token, Missing -> invalid_grant
    const denyCode = await data(
      await h.request("/auth/device/code", "", { method: "POST" }),
    );
    await data(
      await h.request("/api/auth/device/approve", "", {
        method: "POST",
        headers: {
          Cookie: `hp_session=${aliceSession.rawToken}`,
          Origin: base,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user_code: denyCode.user_code, action: "deny" }),
      }),
    );
    const deniedPoll = await h.request("/auth/device/token", "", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: denyCode.device_code }),
    });
    expect(deniedPoll.status).toBe(400);
    expect(await deniedPoll.json()).toEqual({ error: "access_denied" });

    const expCode = await data(await h.request("/auth/device/code", "", { method: "POST" }));
    await h.db.batch([
      {
        sql: "UPDATE device_codes SET expires_at = '2000-01-01T00:00:00Z' WHERE user_code = ?",
        values: [expCode.user_code],
      },
    ]);
    const expPoll = await h.request("/auth/device/token", "", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: expCode.device_code }),
    });
    expect(expPoll.status).toBe(400);
    expect(await expPoll.json()).toEqual({ error: "expired_token" });

    const unknownPoll = await h.request("/auth/device/token", "", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: "deadbeef" }),
    });
    expect(unknownPoll.status).toBe(400);
    expect(await unknownPoll.json()).toEqual({ error: "invalid_grant" });
  });

  it("lists, mints, and revokes individual device_tokens without affecting other devices or sessions", async () => {
    const aliceSession = await h.auth.createSession("alice", "Browser");

    // Mint two device tokens (e.g. Laptop A and CI)
    const mintA = await h.request("/api/auth/tokens", "", {
      method: "POST",
      headers: {
        Cookie: `hp_session=${aliceSession.rawToken}`,
        Origin: base,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Laptop A" }),
    });
    expect(mintA.status).toBe(201);
    const bodyA = await mintA.json<any>();
    expect(bodyA.token).toMatch(/^hpd_[0-9a-f]{48}$/);
    expect(bodyA.item).toEqual({
      id: expect.any(String),
      name: "Laptop A",
      tokenPrefix: `${bodyA.token.slice(0, 10)}…`,
      createdAt: expect.any(String),
      lastUsedAt: null,
    });

    const mintB = await h.request("/api/auth/tokens", "", {
      method: "POST",
      headers: {
        Cookie: `hp_session=${aliceSession.rawToken}`,
        Origin: base,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "GitHub Actions CI" }),
    });
    expect(mintB.status).toBe(201);
    const bodyB = await mintB.json<any>();

    // Use Laptop A token once -> updates lastUsedAt
    expect((await h.request("/api/catalog", bodyA.token)).status).toBe(200);

    // List active tokens -> newest first, never exposes plaintext token or token_hash
    const listRes = await data(
      await h.request("/api/auth/tokens", "", {
        headers: { Cookie: `hp_session=${aliceSession.rawToken}` },
      }),
    );
    expect(listRes.tokens.map((t: any) => t.name)).toEqual([
      "GitHub Actions CI",
      "Laptop A",
      "Alice CLI",
    ]);
    const listedA = listRes.tokens.find((t: any) => t.id === bodyA.item.id);
    expect(listedA.lastUsedAt).toEqual(expect.any(String));
    expect(listedA.token).toBeUndefined();
    expect(listedA.token_hash).toBeUndefined();

    // Bob cannot revoke Alice's token -> 404
    expect(
      (await h.request(`/api/auth/tokens/${bodyA.item.id}`, "bob", { method: "DELETE" })).status,
    ).toBe(404);

    // Alice revokes Laptop A token
    const revokeRes = await h.request(`/api/auth/tokens/${bodyA.item.id}`, "", {
      method: "DELETE",
      headers: { Cookie: `hp_session=${aliceSession.rawToken}`, Origin: base },
    });
    expect(await data(revokeRes)).toEqual({ ok: true });
    expect(h.disconnected).toContain("alice");

    // Revoked Laptop A token immediately returns 401
    expect((await h.request("/api/catalog", bodyA.token)).status).toBe(401);
    // CI token AND browser session remain valid!
    expect((await h.request("/api/catalog", bodyB.token)).status).toBe(200);
    expect(
      (
        await h.request("/api/catalog", "", {
          headers: { Cookie: `hp_session=${aliceSession.rawToken}` },
        })
      ).status,
    ).toBe(200);

    // Revoked token no longer appears in active list
    const afterList = await data(
      await h.request("/api/auth/tokens", "", {
        headers: { Cookie: `hp_session=${aliceSession.rawToken}` },
      }),
    );
    expect(afterList.tokens.some((t: any) => t.id === bodyA.item.id)).toBe(false);
  });

  it("keeps /auth/dev-login 404 by default and enables session + optional deviceToken when ALLOW_DEV_LOGIN=1", async () => {
    // Default config: ALLOW_DEV_LOGIN is unset -> meta tag is "0" and POST /auth/dev-login returns 404
    const defaultDash = await (await h.request("/dashboard", "")).text();
    expect(defaultDash).toContain('<meta name="hp-dev-login" content="0">');

    const disabledRes = await h.request("/auth/dev-login", "", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "devuser" }),
    });
    expect(disabledRes.status).toBe(404);

    // Explicitly enable ALLOW_DEV_LOGIN
    sqlite.close();
    h = harness({
      ALLOW_DEV_LOGIN: "1",
      GITHUB_CLIENT_ID: undefined,
      GITHUB_CLIENT_SECRET: undefined,
    });

    const devDash = await (await h.request("/dashboard", "")).text();
    expect(devDash).toContain('<meta name="hp-oauth" content="0">');
    expect(devDash).toContain('<meta name="hp-dev-login" content="1">');

    const devLoginRes = await h.request("/auth/dev-login", "", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        login: "localdev",
        issueDeviceToken: true,
        deviceName: "Local Smoke",
      }),
    });
    expect(devLoginRes.status).toBe(200);
    const setCookie = devLoginRes.headers.get("Set-Cookie") || "";
    expect(setCookie).toContain("hp_session=hps_");
    const devSessionVal = setCookie.split(";")[0].split("=")[1];

    const devBody = await devLoginRes.json<any>();
    expect(devBody).toEqual({
      authenticated: true,
      user: {
        id: expect.any(String),
        login: "localdev",
        github_id: "dev:localdev",
        avatarUrl: "https://github.com/localdev.png?size=80",
      },
      deviceToken: expect.stringMatching(/^hpd_[0-9a-f]{48}$/),
    });

    // Both browser session cookie and issued deviceToken work immediately
    expect(
      (
        await h.request("/api/session", "", {
          headers: { Cookie: `hp_session=${devSessionVal}` },
        })
      ).status,
    ).toBe(200);
    expect((await h.upload("<body>dev-ok</body>", devBody.deviceToken, "dev-page")).status).toBe(201);
  });
});

describe("removed legacy team routes and scope parameters", () => {
  it("rejects /join/*, /api/workspace/*, /api/archives/:id/publish, and ?scope=* with 404 or 400", async () => {
    const uploaded = await data(await h.upload("<body>doc</body>", "alice", "my-doc"));

    expect((await h.request("/join/inv_123456", "alice")).status).toBe(404);
    expect((await h.request("/auth/login?next=/join/inv_123456", "")).status).toBe(400);
    expect((await h.request("/api/workspace/members", "alice")).status).toBe(404);
    expect((await h.request("/api/workspace/members/bob", "alice", { method: "DELETE" })).status).toBe(404);
    expect((await h.request("/api/workspace/storage", "alice")).status).toBe(404);
    expect((await h.send("/api/workspace/storage", { endpoint: "https://s3.example.com" }, "alice", "PUT")).status).toBe(404);
    expect((await h.send(`/api/archives/${uploaded.id}/publish`, { version: 1 }, "alice", "POST")).status).toBe(404);

    expect((await h.request("/api/catalog?scope=team", "alice")).status).toBe(400);
    expect((await h.request("/api/catalog?scope=personal", "alice")).status).toBe(400);
    expect((await h.upload("<body>x</body>", "alice", "team-doc", "&scope=team")).status).toBe(400);
    expect((await h.upload("<body>x</body>", "alice", "personal-doc", "&scope=personal")).status).toBe(400);

    const form = new FormData();
    form.set("file", new File(["<h1>hi</h1>"], "index.html", { type: "text/html" }));
    form.set("scope", "team");
    expect(
      (
        await h.request("/upload", "alice", {
          method: "POST",
          body: form,
        })
      ).status,
    ).toBe(400);
  });
});

describe("public share links (/s/:token) and four-layer sandbox isolation", () => {
  it("keeps unshared documents strictly private and blocks non-owner share/preview access", async () => {
    const doc = await data(await h.upload("<body>secret</body>", "alice", "private-doc"));
    expect(doc.shared).toBe(false);
    expect(doc.shareUrl).toBeNull();

    const catalogRes = await data(await h.request("/api/catalog", "alice"));
    expect(catalogRes.archives[0].shared).toBe(false);
    expect(catalogRes.archives[0].shareUrl).toBeNull();
    expect(catalogRes.archives[0].sharedAt).toBeNull();

    expect((await h.request(raw(doc.url), "")).status).toBe(302);
    expect((await h.request(raw(doc.url), "bob")).status).toBe(404);
    expect((await h.request(`/api/archives/${doc.id}/share`, "bob", { method: "POST" })).status).toBe(404);
    expect((await h.request(`/api/archives/${doc.id}/share`, "bob", { method: "DELETE" })).status).toBe(404);
    expect((await h.request(`/api/archives/${doc.id}/share`, "", { method: "POST", headers: { Origin: base } })).status).toBe(401);
  });

  it("enables public share idempotently and serves raw HTML without auth or sidebar bridge", async () => {
    const html = "<!doctype html><html><body><h1>Public Report</h1></body></html>";
    const doc = await data(await h.upload(html, "alice", "report"));

    const firstShare = await data(
      await h.request(`/api/archives/${doc.id}/share`, "alice", { method: "POST" }),
    );
    expect(firstShare.shared).toBe(true);
    expect(firstShare.shareUrl).toMatch(new RegExp(`^${base}/s/[a-f0-9]{24}/$`));
    expect(firstShare.sharedAt).toEqual(expect.any(String));

    // Idempotent repeat POST (including via public_id) returns the exact same shareUrl
    const publicId = raw(doc.url).split("/")[2];
    const secondShare = await data(
      await h.request(`/api/archives/${publicId}/share`, "alice", { method: "POST" }),
    );
    expect(secondShare.shareUrl).toBe(firstShare.shareUrl);
    expect(secondShare.sharedAt).toBe(firstShare.sharedAt);

    // Catalog reflects shared state and shareUrl
    const cat = await data(await h.request("/api/catalog", "alice"));
    expect(cat.archives[0].shared).toBe(true);
    expect(cat.archives[0].shareUrl).toBe(firstShare.shareUrl);
    expect(cat.archives[0].sharedAt).toBe(firstShare.sharedAt);

    const sharePath = raw(firstShare.shareUrl); // /s/<token>/
    const barePath = sharePath.slice(0, -1); // /s/<token>

    // Bare /s/<token> redirects with 302 + Cache-Control: no-store to /s/<token>/
    const redirectRes = await h.request(barePath, "");
    expect(redirectRes.status).toBe(302);
    expect(redirectRes.headers.get("Location")).toBe(firstShare.shareUrl);
    expect(redirectRes.headers.get("Cache-Control")).toBe("no-store");

    // Unauthenticated GET /s/<token>/ returns raw HTML without sidebar bridge and with full sandbox headers
    const pubRes = await h.request(sharePath, "");
    expect(pubRes.status).toBe(200);
    const body = await pubRes.text();
    expect(body).toBe(html);
    expect(body).not.toContain("html-preview:toggle-sidebar");

    const csp = pubRes.headers.get("Content-Security-Policy") || "";
    expect(csp).toBe(
      "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads",
    );
    expect(csp).not.toContain("allow-same-origin");
    expect(pubRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(pubRes.headers.get("Cache-Control")).toBe("no-store");
    expect(pubRes.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(pubRes.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(pubRes.headers.get("X-Content-Type-Options")).toBe("nosniff");

    // HEAD works cleanly and non-GET/HEAD on /s/* returns 405
    const headRes = await h.request(sharePath, "", { method: "HEAD" });
    expect(headRes.status).toBe(200);
    expect(await headRes.text()).toBe("");
    expect((await h.request(sharePath, "alice", { method: "POST" })).status).toBe(405);
  });

  it("follows latest version automatically on /s/<token>/ while blocking /v1/ history paths", async () => {
    const v1 = await data(await h.upload("<body>v1-draft</body>", "alice", "live-doc"));
    const shared = await data(
      await h.request(`/api/archives/${v1.id}/share`, "alice", { method: "POST" }),
    );
    const sharePath = raw(shared.shareUrl);

    expect(await (await h.request(sharePath, "")).text()).toBe("<body>v1-draft</body>");

    const v2 = await data(await h.upload("<body>v2-final</body>", "alice", "live-doc"));
    expect(v2.version).toBe(2);
    expect(v2.shared).toBe(true);
    expect(v2.shareUrl).toBe(shared.shareUrl);

    // Public share immediately serves v2
    expect(await (await h.request(sharePath, "")).text()).toBe("<body>v2-final</body>");

    // Historical /v1/ path is strictly 404 on /s/<token>/ while still accessible to owner via /p/
    const v1PubRes = await h.request(`${sharePath}v1/`, "");
    expect(v1PubRes.status).toBe(404);
    expect(await v1PubRes.text()).toContain("请向分享者获取开窗链接。");
    expect(await (await h.request(raw(v1.versionUrl), "alice")).text()).toBe(
      await injectSidebarBridge("<body>v1-draft</body>"),
    );
  });

  it("serves multi-file ZIP assets and nested subdirectories under /s/<token>/ without auth", async () => {
    const zip = zipSync({
      "index.html": strToU8('<link rel="stylesheet" href="./assets/app.css"><script type="module" src="./assets/app.js"></script>'),
      "assets/app.css": strToU8("body{color:red}"),
      "assets/app.js": strToU8("console.log('ok')"),
      "sub/index.html": strToU8("<h2>Sub Page</h2>"),
    });
    const uploaded = await data(
      await h.request("/upload?name=zip-share", "alice", {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: zip,
      }),
    );
    const shared = await data(
      await h.request(`/api/archives/${uploaded.id}/share`, "alice", { method: "POST" }),
    );
    const sharePath = raw(shared.shareUrl);

    // Relative CSS & JS assets work unauthenticated even with Origin: null (opaque sandbox origin)
    const cssRes = await h.request(`${sharePath}assets/app.css`, "", {
      headers: { Origin: "null" },
    });
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await cssRes.text()).toBe("body{color:red}");

    const jsRes = await h.request(`${sharePath}assets/app.js`, "", {
      headers: { Origin: "null" },
    });
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await jsRes.text()).toBe("console.log('ok')");

    // Subdirectory without trailing slash redirects with 307 + Cache-Control: no-store
    const subRedirect = await h.request(`${sharePath}sub`, "");
    expect(subRedirect.status).toBe(307);
    expect(subRedirect.headers.get("Location")).toBe(`${base}${sharePath}sub/`);
    expect(subRedirect.headers.get("Cache-Control")).toBe("no-store");

    const subPage = await h.request(`${sharePath}sub/`, "");
    expect(subPage.status).toBe(200);
    expect(subPage.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await subPage.text()).toBe("<h2>Sub Page</h2>");
  });

  it("revokes access immediately on unshare and rotates the link on re-share", async () => {
    const doc = await data(await h.upload("<body>rotatable</body>", "alice", "rotate-doc"));
    const firstShare = await data(
      await h.request(`/api/archives/${doc.id}/share`, "alice", { method: "POST" }),
    );
    const firstPath = raw(firstShare.shareUrl);
    expect((await h.request(firstPath, "")).status).toBe(200);

    // Unshare revokes immediately
    const unshared = await data(
      await h.request(`/api/archives/${doc.id}/share`, "alice", { method: "DELETE" }),
    );
    expect(unshared).toMatchObject({
      id: doc.id,
      shared: false,
      shareUrl: null,
      sharedAt: null,
    });
    const revokedRes = await h.request(firstPath, "");
    expect(revokedRes.status).toBe(404);
    expect(revokedRes.headers.get("Cache-Control")).toBe("no-store");
    expect(await revokedRes.text()).toContain("请向分享者获取开窗链接。");

    // Re-sharing generates a brand new token; old link remains dead
    const secondShare = await data(
      await h.request(`/api/archives/${doc.id}/share`, "alice", { method: "POST" }),
    );
    expect(secondShare.shareUrl).not.toBe(firstShare.shareUrl);
    expect((await h.request(firstPath, "")).status).toBe(404);
    const secondPath = raw(secondShare.shareUrl);
    expect((await h.request(secondPath, "")).status).toBe(200);

  });

  it("purges every version, asset and interaction and leaves only opaque link tombstones", async () => {
    const first = await data(await h.upload("<body>original draft</body>", "alice", "fall-me"));
    const archivePath = `/api/archives/${first.id}`;
    const shared = await data(await h.request(`${archivePath}/share`, "alice", { method: "POST" }));
    const files = zipSync({
      "index.html": strToU8("<body>original final</body>"),
      "assets/site.css": strToU8("body { color: red; }"),
    });
    const second = await data(await h.request("/upload?name=fall-me", "alice", {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: files,
    }));
    await data(await h.send(`${archivePath}/bindings`, { adapterId: "claude", sessionRef: "session-1" }));
    await data(await h.send(`${archivePath}/interactions`, {
      requestId: "fall-interaction", intent: "change", prompt: "Original interaction",
    }));
    expect(h.objects.size).toBe(3);
    expect((await h.request(`${raw(second.versionUrl)}assets/site.css`)).headers.get("Cache-Control")).toBe("no-store");

    await data(await h.request(archivePath, "alice", { method: "DELETE" }));

    const privatePath = raw(first.url);
    const publicPath = raw(shared.shareUrl);
    for (const [path, user] of [
      [privatePath, "alice"], [privatePath.slice(0, -1), "alice"], [`/p/${first.id}/`, "alice"],
      [raw(first.versionUrl), "alice"], [raw(second.versionUrl), "alice"],
      [`${raw(second.versionUrl)}assets/site.css`, "alice"],
      [publicPath, ""], [publicPath.slice(0, -1), ""], [`${publicPath}assets/site.css`, ""],
    ]) {
      const response = await h.request(path, user);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = await response.text();
      expect(body).toContain("<h1>此页已落</h1>");
      expect(body).not.toMatch(/original|fall-me|html-preview:toggle-sidebar/i);
      const head = await h.request(path, user, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    }
    expect((await h.request(privatePath, "bob")).status).toBe(404);
    expect((await h.request(privatePath, "")).status).toBe(302);
    expect((await h.request(archivePath, "bob", { method: "DELETE" })).status).toBe(404);
    await data(await h.request(archivePath, "alice", { method: "DELETE" }));
    expect((await data(await h.request("/api/catalog"))).archives).toEqual([]);
    expect(h.objects.size).toBe(0);
    for (const table of ["documents", "versions", "session_bindings", "interactions", "interaction_deliveries", "interaction_events"]) {
      expect(await h.db.all(`SELECT * FROM ${table}`)).toEqual([]);
    }
    expect(await h.db.all("SELECT * FROM page_tombstones")).toEqual([{
      id_hash: await hash(first.id),
      public_id_hash: await hash(privatePath.split("/")[2]),
      owner_id: "alice",
      share_token_hash: await hash(publicPath.split("/")[2]),
    }]);

    const replacement = await data(await h.upload("<body>fresh page</body>", "alice", "fall-me"));
    expect(replacement.url).not.toBe(first.url);
    expect(await (await h.request(privatePath)).text()).toContain("此页已落");
  });

  it("hides all content during partial deletion and supports retrying the storage cleanup", async () => {
    const doc = await data(await h.upload("<body>first</body>"));
    await data(await h.upload("<body>second</body>"));
    const archivePath = `/api/archives/${doc.id}`;
    const shared = await data(await h.request(`${archivePath}/share`, "alice", { method: "POST" }));
    const remove = h.store.delete;
    vi.spyOn(h.store, "delete").mockImplementationOnce(remove).mockRejectedValueOnce(Error("storage outage"));

    expect((await h.request(archivePath, "alice", { method: "DELETE" })).status).toBe(503);
    expect(h.objects.size).toBe(1);
    expect(await (await h.request(raw(doc.url))).text()).toContain("此页已落");
    expect(await (await h.request(raw(shared.shareUrl), "")).text()).toContain("此页已落");
    expect((await h.upload()).status).toBe(409);

    const retries = await Promise.all([
      h.request(archivePath, "alice", { method: "DELETE" }),
      h.request(archivePath, "alice", { method: "DELETE" }),
    ]);
    expect(retries.map(response => response.status)).toEqual([200, 200]);
    expect(h.objects.size).toBe(0);
  });

  it("rejects an upload that started on a page before it fell", async () => {
    const doc = await data(await h.upload());
    const put = h.store.put;
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.spyOn(h.store, "put").mockImplementationOnce(async (...args) => {
      started.resolve();
      await resume.promise;
      await put(...args);
    });
    const upload = h.upload("<body>concurrent upload</body>");
    await started.promise;
    try {
      await data(await h.request(`/api/archives/${doc.id}`, "alice", { method: "DELETE" }));
    } finally {
      resume.resolve();
    }
    expect((await upload).status).toBe(409);
    expect(h.objects.size).toBe(0);
    expect((await data(await h.request("/api/catalog"))).archives).toEqual([]);
    expect(await (await h.request(raw(doc.url))).text()).toContain("此页已落");
  });

  it("blocks Origin: null on /api/* and /upload, never leaks CORS on private routes, and sets anti-framing headers", async () => {
    const doc = await data(await h.upload("<body>check</body>", "alice", "sec-doc"));

    // Origin: null is rejected with 403 across GET and POST API/upload endpoints
    expect(
      (await h.request("/api/session", "alice", { headers: { Origin: "null" } })).status,
    ).toBe(403);
    expect(
      (await h.request("/api/catalog", "alice", { headers: { Origin: "null" } })).status,
    ).toBe(403);
    expect(
      (
        await h.request("/auth/device/code", "", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "null" },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.request("/upload?name=evil", "alice", {
          method: "POST",
          headers: { "Content-Type": "text/html", Origin: "null" },
          body: "<body>evil</body>",
        })
      ).status,
    ).toBe(403);

    // Private routes NEVER include Access-Control-Allow-Origin
    const sessionRes = await h.request("/api/session", "alice");
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const catalogRes = await h.request("/api/catalog", "alice");
    expect(catalogRes.status).toBe(200);
    expect(catalogRes.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const previewRes = await h.request(raw(doc.url), "alice");
    expect(previewRes.status).toBe(200);
    expect(previewRes.headers.get("Access-Control-Allow-Origin")).toBeNull();

    // Dashboard and /auth/login carry anti-framing headers
    const dashRes = await h.request("/dashboard", "");
    expect(dashRes.status).toBe(200);
    expect(dashRes.headers.get("X-Frame-Options")).toBe("DENY");
    expect(dashRes.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");

    const loginRes = await h.request("/auth/login", "");
    expect(loginRes.status).toBe(302);
    expect(loginRes.headers.get("X-Frame-Options")).toBe("DENY");
    expect(loginRes.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
  });
});
