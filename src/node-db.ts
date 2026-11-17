import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Database, Value } from "./database";

const INIT_MIGRATION_NAME = "0001_init.sql";

const LEGACY_MIGRATION_NAMES = [
  "0001.sql",
  "0002_drop_team.sql",
  "0003_public_share.sql",
  "0004_github_device_auth.sql",
  "0005_interactions.sql",
  "0006_daemon_routing.sql",
] as const;

function hasTable(sqlite: DatabaseSync, table: string): boolean {
  const row = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return Boolean(row);
}

function tableColumns(sqlite: DatabaseSync, table: string): Set<string> {
  if (!hasTable(sqlite, table)) return new Set();
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map(r => r.name));
}

function ensureColumn(sqlite: DatabaseSync, table: string, colName: string, ddl: string): void {
  const cols = tableColumns(sqlite, table);
  if (cols.size > 0 && !cols.has(colName)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
  }
}

function upgradeLegacySelfHostedSchema(sqlite: DatabaseSync, initSql: string, nowIso: string): void {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    // 0002: Remove legacy team scope & workspace tables; strip invite_code from oauth_states if present
    if (hasTable(sqlite, "documents")) {
      sqlite.exec("DELETE FROM documents WHERE scope = 'team';");
    }
    sqlite.exec("DROP TABLE IF EXISTS workspace_members;");
    sqlite.exec("DROP TABLE IF EXISTS workspaces;");
    if (tableColumns(sqlite, "oauth_states").has("invite_code")) {
      sqlite.exec("DROP TABLE IF EXISTS oauth_states;");
    }

    // 0003: Public share columns on documents
    ensureColumn(sqlite, "documents", "share_token", "share_token TEXT");
    ensureColumn(sqlite, "documents", "shared_at", "shared_at TEXT");

    // 0004: Rebuild users table if it still has legacy API-key columns
    if (tableColumns(sqlite, "users").has("key_hash")) {
      sqlite.exec(`
        CREATE TABLE users_new (
          id TEXT PRIMARY KEY,
          github_id TEXT NOT NULL UNIQUE,
          login TEXT NOT NULL UNIQUE COLLATE NOCASE,
          created_at TEXT NOT NULL
        );
        INSERT INTO users_new (id, github_id, login, created_at)
        SELECT id, github_id, login, created_at
        FROM users
        WHERE github_id IS NOT NULL AND TRIM(github_id) != '';
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
    }

    // 0006: Additive daemon routing columns on existing 0005 interaction tables
    ensureColumn(sqlite, "session_bindings", "host_id", "host_id TEXT");
    ensureColumn(sqlite, "session_bindings", "host_name", "host_name TEXT");
    ensureColumn(sqlite, "session_bindings", "opaque_binding", "opaque_binding TEXT");
    ensureColumn(sqlite, "interactions", "target_host_id", "target_host_id TEXT");
    ensureColumn(sqlite, "interactions", "target_host_name", "target_host_name TEXT");
    ensureColumn(sqlite, "interaction_deliveries", "target_host_id", "target_host_id TEXT");

    // Apply all `CREATE TABLE IF NOT EXISTS` & `CREATE INDEX IF NOT EXISTS` from 0001_init.sql
    sqlite.exec(initSql);

    // Align _migrations table to squashed 0001_init.sql
    const placeholders = LEGACY_MIGRATION_NAMES.map(() => "?").join(", ");
    sqlite
      .prepare(`DELETE FROM _migrations WHERE name IN (${placeholders})`)
      .run(...LEGACY_MIGRATION_NAMES);
    sqlite
      .prepare("INSERT OR IGNORE INTO _migrations(name, applied_at) VALUES (?, ?)")
      .run(INIT_MIGRATION_NAME, nowIso);

    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

export function applyMigrations(
  sqlite: DatabaseSync,
  dir: string | URL = new URL("../migrations", import.meta.url),
): void {
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);",
  );
  const folder = typeof dir === "string" ? dir : fileURLToPath(dir);
  const applied = new Set(
    (sqlite.prepare("SELECT name FROM _migrations").all() as Array<{ name: string }>).map(
      row => row.name,
    ),
  );
  const files = readdirSync(folder)
    .filter(name => name.endsWith(".sql"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const hasLegacy = LEGACY_MIGRATION_NAMES.some(legacyName => applied.has(legacyName));
  if (hasLegacy && !applied.has(INIT_MIGRATION_NAME) && files.includes(INIT_MIGRATION_NAME)) {
    const initSql = readFileSync(join(folder, INIT_MIGRATION_NAME), "utf8");
    upgradeLegacySelfHostedSchema(sqlite, initSql, new Date().toISOString());
    for (const legacyName of LEGACY_MIGRATION_NAMES) {
      applied.delete(legacyName);
    }
    applied.add(INIT_MIGRATION_NAME);
  }

  for (const name of files) {
    if (applied.has(name)) continue;
    sqlite.exec(readFileSync(join(folder, name), "utf8"));
    sqlite
      .prepare("INSERT INTO _migrations(name, applied_at) VALUES (?, ?)")
      .run(name, new Date().toISOString());
    applied.add(name);
  }
}

export function sqliteDatabase(sqlite: DatabaseSync): Database {
  return {
    async all<T>(sql: string, values: Value[] = []) {
      return sqlite.prepare(sql).all(...(values as SQLInputValue[])) as T[];
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (const { sql, values = [] } of statements) {
          sqlite.prepare(sql).run(...(values as SQLInputValue[]));
        }
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
