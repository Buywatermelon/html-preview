import type { Database } from "./database";
import { HttpError } from "./common";
import type { User } from "./catalog";

export interface AuthConfig {
  PUBLIC_BASE_URL: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  ADMIN_GITHUB_LOGIN?: string;
  BOOTSTRAP_GITHUB_LOGIN?: string;
  ALLOW_DEV_LOGIN?: string | boolean;
}

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

export const randomToken = () => randomHex(32);

export const githubOAuthConfigured = (config: AuthConfig) =>
  Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET);

export function devLoginEnabled(config: AuthConfig): boolean {
  return (
    config.ALLOW_DEV_LOGIN === true ||
    config.ALLOW_DEV_LOGIN === "1" ||
    config.ALLOW_DEV_LOGIN === "true"
  );
}

export async function hash(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map(n => n.toString(16).padStart(2, "0"))
    .join("");
}

const cookie = (request: Request, name: string) =>
  request.headers
    .get("Cookie")
    ?.split(";")
    .map(s => s.trim())
    .find(s => s.startsWith(`${name}=`))
    ?.slice(name.length + 1);

const json = (value: unknown, status = 200, extraHeaders?: Record<string, string>) =>
  Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", ...extraHeaders },
  });

export const avatarUrl = (u: { github_id?: string | null; login: string }) =>
  u.github_id && /^\d+$/.test(u.github_id)
    ? `https://avatars.githubusercontent.com/u/${u.github_id}?v=4&s=80`
    : `https://github.com/${u.login}.png?size=80`;

export type Credential =
  | { kind: "session"; hash: string }
  | { kind: "device_token"; hash: string };

export async function requestCredential(request: Request): Promise<Credential | undefined> {
  const bearer = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) {
    return { kind: "device_token", hash: await hash(bearer) };
  }
  const sessionVal = cookie(request, "__Host-hp_session") || cookie(request, "hp_session");
  if (sessionVal) {
    return { kind: "session", hash: await hash(sessionVal) };
  }
  return undefined;
}

export async function credentialUser(db: Database, credential?: Credential): Promise<User | undefined> {
  if (!credential) return undefined;
  if (credential.kind === "session") {
    const nowIso = new Date().toISOString();
    return (
      await db.all<User>(
        "SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
        [credential.hash, nowIso],
      )
    )[0];
  }
  if (credential.kind === "device_token") {
    return (
      await db.all<User>(
        "SELECT u.* FROM device_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL",
        [credential.hash],
      )
    )[0];
  }
  return undefined;
}

const USER_CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let chars = "";
  for (let i = 0; i < 8; i++) {
    chars += USER_CODE_CHARSET[bytes[i] & 31];
  }
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

export function normalizeUserCode(input: string): string {
  const cleaned = input.toUpperCase().replace(/[\s-]+/g, "");
  if (cleaned.length === 8) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
  }
  return input.trim().toUpperCase();
}

function sanitizeName(value: string, maxLen = 80): string {
  return value.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, maxLen);
}

async function readBodyParams(request: Request): Promise<Record<string, unknown>> {
  const ct = (request.headers.get("Content-Type") || "").toLowerCase();
  const text = await request.text();
  if (!text.trim()) return {};
  if (ct.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Invalid request body");
  }
  return parsed as Record<string, unknown>;
}

const SAFE_NEXT_RE = /^(?:\/dashboard(?:[?#]|$)|\/p\/[a-z0-9-]+\/)/;
const SESSION_MAX_AGE_SEC = 2_592_000; // 30 days
const DEVICE_CODE_TTL_SEC = 600; // 10 minutes
const DEVICE_CODE_INTERVAL_SEC = 2;

export class Auth {
  private base: string;

  constructor(
    private db: Database,
    private config: AuthConfig,
    private disconnect: (userId: string) => Promise<void> = async () => {},
  ) {
    this.base = config.PUBLIC_BASE_URL.replace(/\/$/, "");
  }

  async user(request: Request): Promise<User | undefined> {
    const cred = await requestCredential(request);
    if (!cred) return undefined;
    const member = await credentialUser(this.db, cred);
    if (member) {
      const nowIso = new Date().toISOString();
      if (cred.kind === "device_token") {
        await this.db.batch([
          {
            sql: "UPDATE device_tokens SET last_used_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
            values: [nowIso, cred.hash],
          },
        ]);
      } else if (cred.kind === "session") {
        await this.db.batch([
          {
            sql: "UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?",
            values: [nowIso, cred.hash],
          },
        ]);
      }
    }
    return member;
  }

  require(user?: User): User {
    if (!user) throw new HttpError(401, "Sign in to html-preview");
    return user;
  }

  private sessionCookie(value: string, age: number): string {
    const secure = this.base.startsWith("https:") ? "; Secure" : "";
    return `hp_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`;
  }

  private oauthCookie(value: string, age: number): string {
    const secure = this.base.startsWith("https:") ? "; Secure" : "";
    return `hp_oauth=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`;
  }

  async createSession(
    userId: string,
    userAgent?: string | null,
  ): Promise<{ rawToken: string; cookieHeader: string }> {
    const rawToken = `hps_${randomHex(32)}`;
    const tokenHash = await hash(rawToken);
    const id = crypto.randomUUID();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const expiresIso = new Date(now + SESSION_MAX_AGE_SEC * 1000).toISOString();
    const ua = userAgent ? sanitizeName(userAgent, 256) || null : null;
    await this.db.batch([
      { sql: "DELETE FROM auth_sessions WHERE expires_at <= ?", values: [nowIso] },
      {
        sql: "INSERT INTO auth_sessions(id, user_id, token_hash, user_agent, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        values: [id, userId, tokenHash, ua, nowIso, expiresIso, nowIso],
      },
    ]);
    return {
      rawToken,
      cookieHeader: this.sessionCookie(rawToken, SESSION_MAX_AGE_SEC),
    };
  }

  async issueDeviceToken(
    userId: string,
    name: string,
  ): Promise<{ id: string; name: string; token: string; tokenPrefix: string; createdAt: string }> {
    const raw = `hpd_${randomHex(24)}`;
    const tokenHash = await hash(raw);
    const tokenPrefix = `${raw.slice(0, 10)}…`;
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const cleanName = sanitizeName(name) || "CLI";
    await this.db.batch([
      {
        sql: "INSERT INTO device_tokens(id, user_id, name, token_hash, token_prefix, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
        values: [id, userId, cleanName, tokenHash, tokenPrefix, createdAt],
      },
    ]);
    return { id, name: cleanName, token: raw, tokenPrefix, createdAt };
  }

  async sessionPayload(user?: User) {
    if (!user) {
      return {
        authenticated: false,
        user: null,
      };
    }
    return {
      authenticated: true,
      user: {
        id: user.id,
        login: user.login,
        github_id: user.github_id,
        avatarUrl: avatarUrl(user),
      },
    };
  }

  async handle(request: Request, user?: User): Promise<Response | undefined> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/auth/login" && request.method === "GET") {
      const next = url.searchParams.get("next") || "/dashboard";
      const isSafeNext =
        SAFE_NEXT_RE.test(next) && !next.includes("\\") && !/[\x00-\x1f\x7f]/.test(next);
      if (!githubOAuthConfigured(this.config)) {
        let location = "/dashboard";
        if (isSafeNext) {
          if (next.startsWith("/dashboard")) {
            location = next;
          } else {
            const dest = new URL("/dashboard", this.base);
            dest.searchParams.set("next", next);
            location = dest.pathname + dest.search;
          }
        }
        return new Response(null, {
          status: 302,
          headers: {
            Location: location,
            "Cache-Control": "no-store",
            "X-Frame-Options": "DENY",
            "Content-Security-Policy": "frame-ancestors 'none'",
          },
        });
      }
      if (!isSafeNext) {
        throw new HttpError(400, "Invalid login destination");
      }
      const state = randomToken();
      const verifier = randomToken();
      const nowIso = new Date().toISOString();
      const expiresIso = new Date(Date.now() + 600_000).toISOString();
      await this.db.batch([
        { sql: "DELETE FROM oauth_states WHERE expires_at < ?", values: [nowIso] },
        {
          sql: "INSERT INTO oauth_states(state, verifier, next, expires_at) VALUES (?, ?, ?, ?)",
          values: [state, verifier, next, expiresIso],
        },
      ]);
      const challenge = btoa(
        String.fromCharCode(
          ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
        ),
      )
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      const target = new URL("https://github.com/login/oauth/authorize");
      target.search = new URLSearchParams({
        client_id: this.config.GITHUB_CLIENT_ID || "",
        redirect_uri: `${this.base}/auth/callback`,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      return new Response(null, {
        status: 302,
        headers: {
          Location: target.href,
          "Set-Cookie": this.oauthCookie(state, 600),
          "Cache-Control": "no-store",
          "X-Frame-Options": "DENY",
          "Content-Security-Policy": "frame-ancestors 'none'",
        },
      });
    }

    if (path === "/auth/callback" && request.method === "GET") {
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!state || !/^[a-f0-9]{64}$/.test(state) || !code || cookie(request, "hp_oauth") !== state) {
        throw new HttpError(400, "Invalid login state");
      }
      const nowIso = new Date().toISOString();
      const row = (
        await this.db.all<{ verifier: string; next: string | null }>(
          "DELETE FROM oauth_states WHERE state = ? AND expires_at > ? RETURNING verifier, next",
          [state, nowIso],
        )
      )[0];
      if (!row) throw new HttpError(400, "Login expired; try again");

      const exchange = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: this.config.GITHUB_CLIENT_ID || "",
          client_secret: this.config.GITHUB_CLIENT_SECRET || "",
          redirect_uri: `${this.base}/auth/callback`,
          code,
          code_verifier: row.verifier,
        }),
      });
      const token = await exchange.json<{ access_token?: string }>();
      if (!exchange.ok || !token.access_token) throw new HttpError(401, "GitHub login failed");

      const profile = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "html-preview",
        },
      });
      const github = await profile.json<{ id: number; login: string }>();
      if (!profile.ok || !github.id || !github.login) throw new HttpError(401, "GitHub login failed");

      const githubId = String(github.id);
      const loginLower = github.login.toLowerCase();

      let member = (
        await this.db.all<User>(
          "SELECT * FROM users WHERE github_id = ? OR (github_id LIKE 'dev:%' AND login = ? COLLATE NOCASE)",
          [githubId, loginLower],
        )
      )[0];

      const now = new Date().toISOString();

      if (!member) {
        const adminLogin = this.config.ADMIN_GITHUB_LOGIN?.trim().toLowerCase() || "";
        const bootstrapLogin = this.config.BOOTSTRAP_GITHUB_LOGIN?.trim().toLowerCase() || "";
        const adminConfigured = Boolean(adminLogin || bootstrapLogin);
        const isAdminLogin =
          (Boolean(adminLogin) && loginLower === adminLogin) ||
          (Boolean(bootstrapLogin) && loginLower === bootstrapLogin);
        const countRow = (await this.db.all<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM users"))[0];
        const isFirstUser = (countRow?.cnt ?? 0) === 0;

        if (!isAdminLogin && (adminConfigured || !isFirstUser)) {
          const headers = new Headers({
            Location: "/dashboard?auth_error=unauthorized",
            "Cache-Control": "no-store",
            "X-Frame-Options": "DENY",
            "Content-Security-Policy": "frame-ancestors 'none'",
          });
          headers.append("Set-Cookie", this.oauthCookie("", 0));
          return new Response(null, { status: 302, headers });
        }

        const userId = crypto.randomUUID();
        await this.db.batch([
          {
            sql: "INSERT INTO users(id, github_id, login, created_at) VALUES (?, ?, ?, ?)",
            values: [userId, githubId, loginLower, now],
          },
        ]);
        member = (await this.db.all<User>("SELECT * FROM users WHERE id = ?", [userId]))[0]!;
      } else {
        await this.db.batch([
          {
            sql: "UPDATE users SET github_id = ?, login = ? WHERE id = ?",
            values: [githubId, loginLower, member.id],
          },
        ]);
        member = { ...member, github_id: githubId, login: loginLower };
      }

      const session = await this.createSession(member.id, request.headers.get("User-Agent"));
      const redirectLocation = row.next || "/dashboard";
      const headers = new Headers({
        Location: redirectLocation,
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "frame-ancestors 'none'",
      });
      headers.append("Set-Cookie", session.cookieHeader);
      headers.append("Set-Cookie", this.oauthCookie("", 0));
      return new Response(null, { status: 302, headers });
    }

    if (path === "/api/session") {
      if (request.method === "GET") {
        const member = this.require(user);
        return json(await this.sessionPayload(member));
      }
      if (request.method === "DELETE") {
        const sessionVal = cookie(request, "__Host-hp_session") || cookie(request, "hp_session");
        if (sessionVal) {
          const tokenHash = await hash(sessionVal);
          await this.db.batch([
            { sql: "DELETE FROM auth_sessions WHERE token_hash = ?", values: [tokenHash] },
          ]);
        }
        if (user) {
          await this.disconnect(user.id);
        }
        return new Response(null, {
          status: 204,
          headers: {
            "Set-Cookie": this.sessionCookie("", 0),
            "Cache-Control": "no-store",
          },
        });
      }
      throw new HttpError(405, "Method not allowed");
    }

    if (path === "/auth/device/code") {
      if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
      const body = await readBodyParams(request);
      const rawClientName = typeof body.client_name === "string" ? sanitizeName(body.client_name) : "";
      const clientName = rawClientName || "html-preview CLI";

      const deviceCode = randomHex(32);
      const deviceCodeHash = await hash(deviceCode);
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const expiresIso = new Date(now + DEVICE_CODE_TTL_SEC * 1000).toISOString();

      let userCode = generateUserCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        const collision = (
          await this.db.all<{ id: string }>(
            "SELECT id FROM device_codes WHERE user_code = ? AND expires_at > ?",
            [userCode, nowIso],
          )
        )[0];
        if (!collision) break;
        userCode = generateUserCode();
      }

      const id = crypto.randomUUID();
      await this.db.batch([
        { sql: "DELETE FROM device_codes WHERE expires_at <= ?", values: [nowIso] },
        {
          sql: "INSERT INTO device_codes(id, device_code_hash, user_code, client_name, status, user_id, expires_at, interval_sec, created_at) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, ?)",
          values: [
            id,
            deviceCodeHash,
            userCode,
            clientName,
            expiresIso,
            DEVICE_CODE_INTERVAL_SEC,
            nowIso,
          ],
        },
      ]);

      return json({
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${this.base}/dashboard`,
        verification_uri_complete: `${this.base}/dashboard?device_code=${userCode}`,
        expires_in: DEVICE_CODE_TTL_SEC,
        interval: DEVICE_CODE_INTERVAL_SEC,
      });
    }

    if (path === "/auth/device/token") {
      if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
      const body = await readBodyParams(request);
      const deviceCode = typeof body.device_code === "string" ? body.device_code.trim() : "";
      if (!deviceCode) {
        return json({ error: "invalid_grant" }, 400);
      }

      const nowIso = new Date().toISOString();
      const row = (
        await this.db.all<{
          id: string;
          client_name: string;
          status: "pending" | "approved" | "denied" | "consumed";
          user_id: string | null;
          expires_at: string;
        }>(
          "SELECT id, client_name, status, user_id, expires_at FROM device_codes WHERE device_code_hash = ?",
          [await hash(deviceCode)],
        )
      )[0];

      if (!row) {
        return json({ error: "invalid_grant" }, 400);
      }
      if (row.expires_at <= nowIso) {
        return json({ error: "expired_token" }, 400);
      }
      if (row.status === "pending") {
        return json({ error: "authorization_pending" }, 400);
      }
      if (row.status === "denied") {
        return json({ error: "access_denied" }, 400);
      }
      if (row.status === "consumed" || !row.user_id) {
        return json({ error: "invalid_grant" }, 400);
      }

      const consumed = (
        await this.db.all<{ id: string; user_id: string; client_name: string }>(
          "UPDATE device_codes SET status = 'consumed' WHERE id = ? AND status = 'approved' AND expires_at > ? RETURNING id, user_id, client_name",
          [row.id, nowIso],
        )
      )[0];
      if (!consumed || !consumed.user_id) {
        return json({ error: "invalid_grant" }, 400);
      }

      const owner = (
        await this.db.all<User>("SELECT * FROM users WHERE id = ?", [consumed.user_id])
      )[0];
      if (!owner) {
        return json({ error: "invalid_grant" }, 400);
      }

      const issued = await this.issueDeviceToken(owner.id, consumed.client_name);
      return json({
        access_token: issued.token,
        token_type: "Bearer",
        token_id: issued.id,
        token_prefix: issued.tokenPrefix,
        user: { id: owner.id, login: owner.login },
      });
    }

    if (path === "/api/auth/device") {
      this.require(user);
      if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
      const rawCode = url.searchParams.get("user_code") || "";
      if (!rawCode.trim()) throw new HttpError(400, "Missing user_code");
      const userCode = normalizeUserCode(rawCode);
      const nowIso = new Date().toISOString();
      const row = (
        await this.db.all<{
          user_code: string;
          client_name: string;
          status: string;
          expires_at: string;
        }>(
          "SELECT user_code, client_name, status, expires_at FROM device_codes WHERE user_code = ? AND expires_at > ?",
          [userCode, nowIso],
        )
      )[0];
      if (!row) throw new HttpError(404, "Device code not found or expired");
      return json({
        userCode: row.user_code,
        clientName: row.client_name,
        status: row.status,
        expiresAt: row.expires_at,
      });
    }

    if (path === "/api/auth/device/approve") {
      const member = this.require(user);
      if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
      const body = await readBodyParams(request);
      const rawCode = typeof body.user_code === "string" ? body.user_code : "";
      if (!rawCode.trim()) throw new HttpError(400, "Missing user_code");
      const userCode = normalizeUserCode(rawCode);
      const action = body.action === undefined ? "approve" : body.action;
      if (action !== "approve" && action !== "deny") {
        throw new HttpError(400, "Invalid action");
      }
      const customName =
        typeof body.client_name === "string" ? sanitizeName(body.client_name) : "";
      const nowIso = new Date().toISOString();

      let updated: { status: string } | undefined;
      if (action === "approve") {
        updated = (
          await this.db.all<{ status: string }>(
            customName
              ? "UPDATE device_codes SET status = 'approved', user_id = ?, client_name = ? WHERE user_code = ? AND status = 'pending' AND expires_at > ? RETURNING status"
              : "UPDATE device_codes SET status = 'approved', user_id = ? WHERE user_code = ? AND status = 'pending' AND expires_at > ? RETURNING status",
            customName ? [member.id, customName, userCode, nowIso] : [member.id, userCode, nowIso],
          )
        )[0];
      } else {
        updated = (
          await this.db.all<{ status: string }>(
            "UPDATE device_codes SET status = 'denied', user_id = NULL WHERE user_code = ? AND status = 'pending' AND expires_at > ? RETURNING status",
            [userCode, nowIso],
          )
        )[0];
      }

      if (!updated) {
        const existing = (
          await this.db.all<{ status: string; expires_at: string }>(
            "SELECT status, expires_at FROM device_codes WHERE user_code = ?",
            [userCode],
          )
        )[0];
        if (!existing || existing.expires_at <= nowIso) {
          throw new HttpError(404, "Device code not found or expired");
        }
        throw new HttpError(409, "Device code already processed");
      }

      return json({ ok: true, status: updated.status });
    }

    if (path === "/api/auth/tokens") {
      const member = this.require(user);
      if (request.method === "GET") {
        const rows = await this.db.all<{
          id: string;
          name: string;
          token_prefix: string;
          created_at: string;
          last_used_at: string | null;
          revoked_at: string | null;
        }>(
          "SELECT id, name, token_prefix, created_at, last_used_at, revoked_at FROM device_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, rowid DESC",
          [member.id],
        );
        return json({
          tokens: rows.map(r => ({
            id: r.id,
            name: r.name,
            tokenPrefix: r.token_prefix,
            createdAt: r.created_at,
            lastUsedAt: r.last_used_at,
            revokedAt: r.revoked_at,
          })),
        });
      }
      if (request.method === "POST") {
        const body = await readBodyParams(request);
        const rawName = typeof body.name === "string" ? sanitizeName(body.name) : "";
        const issued = await this.issueDeviceToken(member.id, rawName || "CLI Token");
        return json(
          {
            token: issued.token,
            item: {
              id: issued.id,
              name: issued.name,
              tokenPrefix: issued.tokenPrefix,
              createdAt: issued.createdAt,
              lastUsedAt: null,
            },
          },
          201,
        );
      }
      throw new HttpError(405, "Method not allowed");
    }

    const tokenMatch = /^\/api\/auth\/tokens\/([^/]+)$/.exec(path);
    if (tokenMatch) {
      const member = this.require(user);
      if (request.method !== "DELETE") throw new HttpError(405, "Method not allowed");
      const tokenId = decodeURIComponent(tokenMatch[1]);
      const existing = (
        await this.db.all<{ id: string; revoked_at: string | null }>(
          "SELECT id, revoked_at FROM device_tokens WHERE id = ? AND user_id = ?",
          [tokenId, member.id],
        )
      )[0];
      if (!existing) throw new HttpError(404, "Token not found");
      if (!existing.revoked_at) {
        const nowIso = new Date().toISOString();
        await this.db.batch([
          {
            sql: "UPDATE device_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
            values: [nowIso, tokenId, member.id],
          },
        ]);
      }
      await this.disconnect(member.id);
      return json({ ok: true });
    }

    if (path === "/auth/dev-login") {
      if (!devLoginEnabled(this.config)) {
        throw new HttpError(404, "Not found");
      }
      if (request.method !== "POST") {
        throw new HttpError(405, "Method not allowed");
      }
      const body = await readBodyParams(request);
      const rawLogin =
        typeof body.login === "string" && body.login.trim()
          ? body.login.trim().toLowerCase()
          : this.config.ADMIN_GITHUB_LOGIN?.trim().toLowerCase() || "dev";
      if (!/^[a-z0-9](?:[a-z0-9_-]{0,38})$/.test(rawLogin)) {
        throw new HttpError(400, "Invalid login");
      }
      const explicitGithubId =
        typeof body.githubId === "string" && body.githubId.trim()
          ? sanitizeName(body.githubId, 64)
          : "";
      const lookupGithubId = explicitGithubId || `dev:${rawLogin}`;

      let member = (
        await this.db.all<User>(
          "SELECT * FROM users WHERE github_id = ? OR login = ? COLLATE NOCASE",
          [lookupGithubId, rawLogin],
        )
      )[0];

      const nowIso = new Date().toISOString();
      if (!member) {
        const userId = crypto.randomUUID();
        await this.db.batch([
          {
            sql: "INSERT INTO users(id, github_id, login, created_at) VALUES (?, ?, ?, ?)",
            values: [userId, lookupGithubId, rawLogin, nowIso],
          },
        ]);
        member = (await this.db.all<User>("SELECT * FROM users WHERE id = ?", [userId]))[0]!;
      } else {
        const nextGithubId = explicitGithubId || member.github_id;
        await this.db.batch([
          {
            sql: "UPDATE users SET github_id = ?, login = ? WHERE id = ?",
            values: [nextGithubId, rawLogin, member.id],
          },
        ]);
        member = { ...member, github_id: nextGithubId, login: rawLogin };
      }

      const session = await this.createSession(member.id, request.headers.get("User-Agent"));
      const wantDeviceToken =
        body.issueDeviceToken === true ||
        body.issueDeviceToken === "true" ||
        body.issueDeviceToken === "1";
      const deviceName =
        typeof body.deviceName === "string" && sanitizeName(body.deviceName)
          ? sanitizeName(body.deviceName)
          : "Dev CLI";
      const issued = wantDeviceToken
        ? await this.issueDeviceToken(member.id, deviceName)
        : undefined;

      const payload = await this.sessionPayload(member);
      return json(
        issued ? { ...payload, deviceToken: issued.token } : payload,
        200,
        { "Set-Cookie": session.cookieHeader },
      );
    }

    return undefined;
  }
}
