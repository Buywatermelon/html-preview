import {
  contentType,
  HttpError,
  safePath,
  validateFolder,
  validateTitle,
} from "./common";
import { parseUpload } from "./upload";
import { dashboardResponse, assetResponse } from "./dashboard";
import { Auth, devLoginEnabled, githubOAuthConfigured, hash, randomHex, type AuthConfig } from "./auth";
import { Catalog, type Document, type User, type Version } from "./catalog";
import { injectSidebarBridge } from "./sidebar-bridge";
import { InteractStore } from "./interact-store";
import {
  buildWebPushPayload,
  pwaManifestResponse,
  serviceWorkerResponse,
  type PushDispatcher,
  type WebPushNotificationPayload,
} from "./pwa";
import type {
  HostPresenceInfo,
  HostPresenceSummary,
  InteractionRecord,
  InteractionStreamEvent,
  NotifyOptions,
  PresenceSnapshot,
  PushSubscriptionInput,
  PushSubscriptionRecord,
  RealtimeEvent,
  SessionBindingInput,
} from "./interact-types";
import type { Database, Statement } from "./database";
import type { ObjectStore } from "./storage";

export type ChangeEvent = RealtimeEvent;

export interface NotifyResult {
  activeBrowserCount?: Record<string, number>;
  onlineHosts?: Record<string, HostPresenceInfo[]>;
}

export interface AppOptions extends AuthConfig {
  db: Database;
  store: ObjectStore;
  notify(
    users: string[],
    event?: RealtimeEvent,
    options?: NotifyOptions,
  ): Promise<NotifyResult | void>;
  presence?(userId: string): Promise<PresenceSnapshot>;
  disconnect(userId: string): Promise<void>;
  defer(promise: Promise<unknown>): void;
  events?(request: Request, user: User): Promise<Response>;
  pushDispatcher?: PushDispatcher;
  VAPID_PUBLIC_KEY?: string;
}

async function parseJsonBody<T = Record<string, unknown>>(
  request: Request,
  allowEmpty = false,
): Promise<T> {
  const text = await request.text();
  if (!text.trim()) {
    if (allowEmpty) return {} as T;
    throw new HttpError(400, "Invalid request");
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Invalid request");
  }
  return parsed as T;
}

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

const SHARE_SANDBOX_CSP =
  "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";

function previewStatusResponse(method: string, text: string, status: number): Response {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${text}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100dvh;display:grid;place-items:center;font:15px/1.6 system-ui,-apple-system,sans-serif;background:Canvas;color:CanvasText;padding:24px;box-sizing:border-box}main{max-width:420px;text-align:center}h1{font-size:18px;margin:0}</style>
</head>
<body>
<main>
<h1>${text}</h1>
</main>
</body>
</html>
`;
  return new Response(method === "HEAD" ? null : html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      ...(status === 200 ? { "X-Html-Preview-Page-State": "fallen" } : {}),
    },
  });
}

const shareNotFoundResponse = (method: string) =>
  previewStatusResponse(method, "请向分享者获取开窗链接。", 404);
const fallenPageResponse = (method: string) => previewStatusResponse(method, "此页已落", 200);

function buildHostPresenceSummary(
  interaction: InteractionRecord,
  onlineHosts: HostPresenceInfo[],
): HostPresenceSummary {
  const targetHostId = interaction.targetHostId ?? null;
  const matchedOnline = targetHostId
    ? onlineHosts.find(h => h.hostId === targetHostId)
    : undefined;
  const targetHostName = matchedOnline?.hostName || interaction.targetHostName || targetHostId;
  const targetHostOnline = targetHostId ? Boolean(matchedOnline) : onlineHosts.length > 0;
  return {
    targetHostId,
    targetHostName: targetHostName ?? null,
    targetHostOnline,
    onlineHostCount: onlineHosts.length,
    onlineHosts,
  };
}

export function createApp(options: AppOptions) {
  const { db, store } = options;
  const base = options.PUBLIC_BASE_URL.replace(/\/$/, "");
  const catalog = new Catalog(db, base);
  const auth = new Auth(db, options, options.disconnect);
  const interactStore = new InteractStore(db, base);

  async function queryPresence(userId: string): Promise<PresenceSnapshot> {
    if (options.presence) {
      return await options.presence(userId);
    }
    return { activeBrowserCount: 0, onlineHosts: [] };
  }

  const defaultPushDispatcher: PushDispatcher = async (
    subscriptions: PushSubscriptionRecord[],
    payload: WebPushNotificationPayload,
  ) => {
    for (const sub of subscriptions) {
      if (
        sub.endpoint.startsWith("http://127.0.0.1:") ||
        sub.endpoint.startsWith("http://localhost:")
      ) {
        const res = await fetch(sub.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.status === 404 || res.status === 410) {
          await interactStore.removePushSubscription(sub.ownerId, sub.endpoint);
        }
      }
    }
  };

  const effectivePushDispatcher: PushDispatcher = async (subscriptions, payload) => {
    const dispatcher = options.pushDispatcher ?? defaultPushDispatcher;
    try {
      await dispatcher(subscriptions, payload);
    } catch (err) {
      const status =
        typeof err === "object" && err !== null
          ? ((err as { status?: unknown; statusCode?: unknown }).status ??
            (err as { statusCode?: unknown }).statusCode)
          : undefined;
      if (status === 404 || status === 410) {
        const targetEndpoint =
          typeof err === "object" &&
          err !== null &&
          typeof (err as { endpoint?: unknown }).endpoint === "string"
            ? (err as { endpoint: string }).endpoint
            : null;
        for (const sub of subscriptions) {
          if (!targetEndpoint || sub.endpoint === targetEndpoint) {
            await interactStore.removePushSubscription(sub.ownerId, sub.endpoint);
          }
        }
        return;
      }
      throw err;
    }
  };

  function dispatchInteractionNotifications(
    ownerId: string,
    docTitle: string,
    interaction: InteractionRecord,
    event: InteractionStreamEvent,
    wakeDaemon = false,
  ) {
    options.defer(
      (async () => {
        const res = await options.notify(
          [ownerId],
          {
            type: "interaction",
            seq: event.seq,
            documentId: interaction.documentId,
            kind: event.kind,
            interaction,
          },
          { targetRole: "browser" },
        );
        if (wakeDaemon) {
          const targetHostId = interaction.targetHostId ?? null;
          await options.notify(
            [ownerId],
            {
              type: "daemon_wake",
              targetHostId,
              documentId: interaction.documentId,
              interactionId: interaction.id,
              targetAdapterId: interaction.targetAdapterId,
            },
            { targetRole: "daemon", targetHostId },
          );
        }
        const pushPayload = buildWebPushPayload(docTitle, interaction, event.kind);
        if (pushPayload) {
          const browserCount = res?.activeBrowserCount?.[ownerId] ?? 0;
          if (browserCount === 0) {
            const mostRecent = await interactStore.getMostRecentPushSubscription(ownerId);
            if (mostRecent) {
              await effectivePushDispatcher([mostRecent], pushPayload);
            }
          }
        }
      })().catch(() => console.error("Interaction notification failed")),
    );
  }

  function result(doc: Document, version: Version) {
    const url = `${base}/p/${doc.public_id}/`;
    return {
      id: doc.id,
      name: doc.name,
      title: doc.title,
      folder: doc.folder,
      shared: Boolean(doc.share_token),
      shareUrl: doc.share_token ? `${base}/s/${doc.share_token}/` : null,
      version: version.version,
      url,
      versionUrl: `${url}v${version.version}/`,
      createdAt: version.created_at,
      fileCount: JSON.parse(version.files).length,
      totalBytes: version.total_bytes,
      note: version.note,
    };
  }

  function notify(doc: Document, version?: Version) {
    options.defer(
      (async () => {
        const event = version ? { ...result(doc, version), type: "upload" as const } : undefined;
        await options.notify([doc.scope], event);
      })().catch(() => console.error("Catalog notification failed")),
    );
  }

  async function removeFiles(prefix: string, files: string[]) {
    for (const path of files) await store.delete(prefix + path);
  }

  async function append(
    doc: Document,
    files: string[],
    total: number,
    note: string,
    storage: string,
    existing: Document | undefined,
    title: string | undefined,
  ) {
    const now = new Date().toISOString();
    const statements: Statement[] = [];
    if (existing && title !== undefined) {
      statements.push({
        sql: "UPDATE documents SET title = ? WHERE id = ? AND folder = ? AND deleting = 0",
        values: [title, existing.id, doc.folder],
      });
    }
    if (!existing) {
      statements.push({
        sql: "INSERT INTO documents(id, public_id, scope, name, title, folder, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
        values: [
          doc.id,
          doc.public_id,
          doc.scope,
          doc.name,
          doc.title,
          doc.folder,
          doc.created_at,
        ],
      });
    }
    statements.push({
      sql: `INSERT INTO versions(document_id, version, storage_id, created_at, note, files, total_bytes)
            SELECT d.id, COALESCE((SELECT MAX(version) FROM versions WHERE document_id = d.id), 0) + 1, ?, ?, ?, ?, ?
            FROM documents d WHERE d.scope = ? AND d.name = ? AND d.folder = ? AND d.deleting = 0${existing ? " AND d.id = ?" : ""}`,
      values: [storage, now, note, JSON.stringify(files), total, doc.scope, doc.name, doc.folder,
        ...(existing ? [existing.id] : []),
      ],
    });
    await db.batch(statements);

    const saved = await catalog.named(doc.scope, doc.name);
    if (!saved || saved.folder !== doc.folder) {
      await removeFiles(storage, files);
      throw new HttpError(409, "Document moved; refresh and retry");
    }
    const versions = await catalog.versions(saved.id);
    const version = versions.find(v => v.storage_id === storage);
    if (!version) {
      await removeFiles(storage, files);
      throw new HttpError(409, "Document moved or was deleted; refresh and retry");
    }
    return { doc: saved, version };
  }

  async function upload(request: Request, user: User) {
    const input = await parseUpload(request);
    const name = input.name || `html-${crypto.randomUUID().replaceAll("-", "")}`;
    const existing = await catalog.named(user.id, name);
    if (existing?.deleting || (existing && input.folder && existing.folder !== input.folder)) {
      throw new HttpError(409, "Document belongs to another task");
    }
    const folder = existing?.folder || input.folder || "uncategorized";
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const doc: Document = existing || {
      id,
      public_id: `${name}-${id.replaceAll("-", "")}`,
      scope: user.id,
      name,
      title: input.title || name,
      folder,
      created_at: now,
      deleting: 0,
      share_token: null,
      shared_at: null,
    };
    const storage = `sites/${crypto.randomUUID()}/`;
    const written: string[] = [];
    try {
      for (const file of input.files) {
        await store.put(storage + file.path, file.data, contentType(file.path));
        written.push(file.path);
      }
    } catch (error) {
      await removeFiles(storage, written).catch(() => {});
      throw error;
    }
    const saved = await append(
      doc,
      input.files.map(f => f.path),
      input.files.reduce((sum, f) => sum + f.data.byteLength, 0),
      input.note,
      storage,
      existing,
      input.title || undefined,
    );
    const hasDaemonBinding = Boolean(input.hostId || input.opaqueBinding);
    const binding = hasDaemonBinding
      ? await interactStore.saveBinding(user.id, saved.doc.id, saved.version.version, {
          hostId: input.hostId,
          hostName: input.hostName,
          opaqueBinding: input.opaqueBinding,
        })
      : undefined;
    const linked = input.resolves?.length
      ? await interactStore.linkVersionToInteractions(
          user.id,
          saved.doc.id,
          saved.version.version,
          input.resolves,
          input.note,
        )
      : [];
    notify(saved.doc, saved.version);
    for (const item of linked) {
      dispatchInteractionNotifications(user.id, saved.doc.title, item.interaction, item.event, false);
    }
    return json(
      {
        ...result(saved.doc, saved.version),
        ...(binding ? { binding } : {}),
        ...(linked.length > 0 ? { linkedInteractions: linked.map(x => x.interaction.id) } : {}),
      },
      201,
    );
  }

  async function preview(request: Request, user: User) {
    const url = new URL(request.url);
    const match = /^\/p\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!match) throw new HttpError(404, "Page not found");
    const selected = await catalog.document(match[1]);
    if (selected ? selected.deleting && selected.scope === user.id : await catalog.isFallenPage(match[1], user.id)) {
      return fallenPageResponse(request.method);
    }
    if (match[2] === undefined) throw new HttpError(404, "Page not found");
    const doc = catalog.visible(selected, user);
    const versions = await catalog.versions(doc.id);
    let path = decodeURIComponent(match[2] || "index.html");
    const fixed = /^v([1-9]\d*)\/(.*)$/.exec(path);
    const version = fixed ? versions.find(v => v.version === Number(fixed[1])) : versions.at(-1);
    if (!version) throw new HttpError(404, "Version not found");
    if (fixed) path = fixed[2] || "index.html";
    path = safePath(path.endsWith("/") ? `${path}index.html` : path);
    const files: string[] = JSON.parse(version.files);
    if (!files.includes(path)) {
      const index = `${path.replace(/\/$/, "")}/index.html`;
      if (files.includes(index)) {
        if (!url.pathname.endsWith("/")) {
          return Response.redirect(`${base}${url.pathname}/${url.search}`, 308);
        }
        path = index;
      } else {
        throw new HttpError(404, "File not found");
      }
    }
    const object = await store.get(version.storage_id + path);
    if (!object) throw new HttpError(404, "File not found");
    const isHtml = contentType(path).startsWith("text/html");
    const headers = new Headers({
      "Content-Type": contentType(path),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    const contentLength = object.headers.get("Content-Length");
    if (contentLength) headers.set("Content-Length", contentLength);
    if (request.method === "HEAD") {
      await object.body?.cancel();
      return new Response(null, { headers });
    }
    if (isHtml) {
      headers.delete("Content-Length");
      return new Response(await injectSidebarBridge(await object.text()), { headers });
    }
    return new Response(object.body, { headers });
  }

  async function publicShare(request: Request): Promise<Response> {
    if (!["GET", "HEAD"].includes(request.method)) {
      throw new HttpError(405, "Method not allowed");
    }
    const url = new URL(request.url);
    const match = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match) return shareNotFoundResponse(request.method);
    const token = match[1];
    if (!/^[a-f0-9]{24,64}$/.test(token)) {
      return shareNotFoundResponse(request.method);
    }
    const doc = await catalog.byShareToken(token);
    if (doc ? doc.deleting : await catalog.isFallenShare(token)) {
      return fallenPageResponse(request.method);
    }
    if (!doc) return shareNotFoundResponse(request.method);
    const latestVersion = await catalog.latestVersion(doc.id);
    if (!latestVersion) return shareNotFoundResponse(request.method);

    if (!match[2]) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${base}/s/${token}/${url.search}`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "X-Robots-Tag": "noindex, nofollow",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    let rawSub: string;
    try {
      rawSub = decodeURIComponent(match[2].slice(1)) || "index.html";
    } catch {
      return json({ error: "Invalid request" }, 400);
    }

    let filePath: string;
    try {
      filePath = safePath(rawSub.endsWith("/") ? `${rawSub}index.html` : rawSub);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message }, err.status);
      }
      throw err;
    }

    const files: string[] = JSON.parse(latestVersion.files);
    if (!files.includes(filePath)) {
      const index = `${filePath.replace(/\/$/, "")}/index.html`;
      if (files.includes(index)) {
        if (!url.pathname.endsWith("/")) {
          return new Response(null, {
            status: 307,
            headers: {
              Location: `${base}${url.pathname}/${url.search}`,
              "Cache-Control": "no-store",
              "Referrer-Policy": "no-referrer",
              "X-Robots-Tag": "noindex, nofollow",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }
        filePath = index;
      } else {
        return shareNotFoundResponse(request.method);
      }
    }

    const object = await store.get(latestVersion.storage_id + filePath);
    if (!object) return shareNotFoundResponse(request.method);

    const headers = new Headers({
      "Content-Type": contentType(filePath),
      "Content-Security-Policy": SHARE_SANDBOX_CSP,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
    });
    const contentLength = object.headers.get("Content-Length");
    if (contentLength) headers.set("Content-Length", contentLength);
    if (request.method === "HEAD") {
      await object.body?.cancel();
      return new Response(null, { headers });
    }
    return new Response(object.body, { headers });
  }

  return async function fetchRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
        throw new HttpError(405, "Method not allowed");
      }
      const origin = request.headers.get("Origin");
      if (
        (path === "/api" || path.startsWith("/api/") || path === "/upload") &&
        origin &&
        origin !== base
      ) {
        throw new HttpError(403, "Invalid request origin");
      }
      if (!["GET", "HEAD"].includes(request.method)) {
        if (
          (origin && origin !== base) ||
          (!origin &&
            !request.headers.has("Authorization") &&
            !["/auth/device/code", "/auth/device/token", "/auth/dev-login"].includes(path))
        ) {
          throw new HttpError(403, "Invalid request origin");
        }
      }
      if (path === "/") return Response.redirect(`${base}/dashboard`, 302);
      if (path === "/manifest.webmanifest" && ["GET", "HEAD"].includes(request.method)) {
        return pwaManifestResponse(request.method);
      }
      if (path === "/sw.js" && ["GET", "HEAD"].includes(request.method)) {
        return serviceWorkerResponse(request.method);
      }
      if (path.startsWith("/assets/") && ["GET", "HEAD"].includes(request.method)) {
        const asset = assetResponse(path, request.method);
        if (asset) return asset;
      }
      if (path === "/dashboard" && ["GET", "HEAD"].includes(request.method)) {
        return dashboardResponse(request, githubOAuthConfigured(options), devLoginEnabled(options));
      }
      if (path === "/s" || path.startsWith("/s/")) {
        return await publicShare(request);
      }

      const user = await auth.user(request);
      const response = await auth.handle(request, user);
      if (response) return response;

      if (!user && path.startsWith("/p/")) {
        return Response.redirect(
          `${base}/auth/login?next=${encodeURIComponent(path + url.search)}`,
          302,
        );
      }

      const member = auth.require(user);

      if (path === "/api/events" && request.method === "GET") {
        if (origin && origin !== base) throw new HttpError(403, "Invalid WebSocket origin");
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          throw new HttpError(426, "Expected WebSocket");
        }
        return options.events
          ? options.events(request, member)
          : new Response("Expected WebSocket", { status: 426 });
      }
      if (path.startsWith("/p/") && ["GET", "HEAD"].includes(request.method)) {
        return await preview(request, member);
      }
      if (path === "/upload" && request.method === "POST") {
        return await upload(request, member);
      }
      if (path === "/api/catalog" && request.method === "GET") {
        if (url.searchParams.has("scope")) {
          throw new HttpError(400, "scope is no longer supported");
        }
        return json(await catalog.list(member));
      }

      const bindingsMatch = /^\/api\/archives\/([^/]+)\/bindings$/.exec(path);
      if (bindingsMatch) {
        const doc = await catalog.document(decodeURIComponent(bindingsMatch[1]));
        if (!doc || doc.deleting || doc.scope !== member.id) {
          throw new HttpError(404, "Document not found");
        }
        if (request.method === "GET") {
          return json({ bindings: await interactStore.listBindings(member.id, doc.id) });
        }
        if (request.method === "POST") {
          const latestVersion = await catalog.latestVersion(doc.id);
          if (!latestVersion) throw new HttpError(404, "Version not found");
          const body = await parseJsonBody<
            SessionBindingInput & { binding?: string }
          >(request);
          if (
            body.version !== undefined &&
            (typeof body.version !== "number" ||
              !Number.isInteger(body.version) ||
              body.version < 1)
          ) {
            throw new HttpError(400, "Invalid version");
          }
          const version = body.version ?? latestVersion.version;
          const binding = await interactStore.saveBinding(member.id, doc.id, version, {
            ...body,
            opaqueBinding: body.opaqueBinding ?? body.binding,
          });
          return json({ binding }, 201);
        }
        throw new HttpError(405, "Method not allowed");
      }

      const interactionsMatch = /^\/api\/archives\/([^/]+)\/interactions$/.exec(path);
      if (interactionsMatch) {
        const doc = await catalog.document(decodeURIComponent(interactionsMatch[1]));
        if (!doc || doc.deleting || doc.scope !== member.id) {
          throw new HttpError(404, "Document not found");
        }
        if (request.method === "GET") {
          const afterSeq = Number(url.searchParams.get("afterSeq") || "0") || 0;
          const [state, presence] = await Promise.all([
            interactStore.listDocumentState(member.id, doc.id, afterSeq),
            queryPresence(member.id),
          ]);
          return json({
            ...state,
            onlineHosts: presence.onlineHosts,
          });
        }
        if (request.method === "POST") {
          const latestVersion = await catalog.latestVersion(doc.id);
          if (!latestVersion) throw new HttpError(404, "Version not found");
          const [body, presence] = await Promise.all([
            parseJsonBody<Parameters<InteractStore["createInteraction"]>[3]>(request),
            queryPresence(member.id),
          ]);
          const out = await interactStore.createInteraction(
            member.id,
            doc,
            latestVersion.version,
            body,
            presence.onlineHosts,
          );
          if (!out.deduplicated) {
            dispatchInteractionNotifications(
              member.id,
              doc.title,
              out.interaction,
              out.event,
              true,
            );
          }
          const hostPresence = buildHostPresenceSummary(out.interaction, presence.onlineHosts);
          return json({ ...out, hostPresence }, out.deduplicated ? 200 : 201);
        }
        throw new HttpError(405, "Method not allowed");
      }

      const handoffMatch = /^\/api\/interactions\/([^/]+)\/handoff$/.exec(path);
      if (handoffMatch) {
        if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
        const interactionId = decodeURIComponent(handoffMatch[1]);
        const body = await parseJsonBody<{ targetHostId?: string }>(request);
        const requestedHostId = (body.targetHostId || "").trim();
        if (!requestedHostId) {
          throw new HttpError(400, "targetHostId is required");
        }
        const presence = await queryPresence(member.id);
        const onlineTarget = presence.onlineHosts.find(h => h.hostId === requestedHostId);
        if (!onlineTarget) {
          throw new HttpError(409, "Target host is not currently online");
        }
        const out = await interactStore.handoffInteraction(member.id, interactionId, {
          targetHostId: onlineTarget.hostId,
          targetHostName: onlineTarget.hostName,
        });
        const doc = await catalog.document(out.interaction.documentId);
        dispatchInteractionNotifications(
          member.id,
          doc?.title || "HTML",
          out.interaction,
          out.event,
          true,
        );
        return json({
          ...out,
          hostPresence: buildHostPresenceSummary(out.interaction, presence.onlineHosts),
        });
      }

      const replyMatch = /^\/api\/interactions\/([^/]+)\/reply$/.exec(path);
      if (replyMatch) {
        if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
        const interactionId = decodeURIComponent(replyMatch[1]);
        const body = await parseJsonBody<Parameters<InteractStore["updateOrReplyInteraction"]>[2]>(
          request,
        );
        const out = await interactStore.updateOrReplyInteraction(member.id, interactionId, body);
        const doc = await catalog.document(out.interaction.documentId);
        dispatchInteractionNotifications(
          member.id,
          doc?.title || "HTML",
          out.interaction,
          out.event,
          body?.action === "retry",
        );
        return json(out);
      }

      if (path === "/api/daemon/claim") {
        if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
        const body = await parseJsonBody<{
          hostId?: string;
          hostName?: string;
          limit?: number;
          leaseSeconds?: number;
          includeDeferred?: boolean;
        }>(request, true);
        const deliveries = await interactStore.claimPendingDeliveries(member.id, {
          hostId: body.hostId,
          hostName: body.hostName,
          limit: body.limit,
          leaseSeconds: body.leaseSeconds,
          includeDeferred: body.includeDeferred === true,
        });
        return json({ deliveries });
      }

      if (path === "/api/daemon/renew") {
        if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
        const body = await parseJsonBody<{
          interactionId?: string;
          fencingToken?: string;
          leaseSeconds?: number;
        }>(request);
        const renewed = await interactStore.renewDeliveryLease(member.id, {
          interactionId: body.interactionId || "",
          fencingToken: body.fencingToken || "",
          leaseSeconds: body.leaseSeconds,
        });
        return json(renewed);
      }

      if (path === "/api/daemon/events") {
        if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
        const body = await parseJsonBody<Parameters<InteractStore["reportDaemonEvent"]>[1]>(
          request,
        );
        const out = await interactStore.reportDaemonEvent(member.id, body);
        if (!out.deduplicated) {
          const doc = await catalog.document(out.interaction.documentId);
          dispatchInteractionNotifications(
            member.id,
            doc?.title || "HTML",
            out.interaction,
            out.event,
            false,
          );
        }
        return json(out);
      }

      if (path === "/api/push/subscriptions") {
        if (request.method === "GET") {
          return json({
            vapidPublicKey: options.VAPID_PUBLIC_KEY || null,
            subscriptions: await interactStore.listPushSubscriptions(member.id),
          });
        }
        if (request.method === "POST") {
          const body = await parseJsonBody<PushSubscriptionInput>(request);
          const subscription = await interactStore.savePushSubscription(member.id, {
            ...body,
            userAgent: body.userAgent || request.headers.get("User-Agent") || undefined,
          });
          return json({ subscription }, 201);
        }
        if (request.method === "DELETE") {
          const body = await parseJsonBody<{ endpoint?: string }>(request, true);
          await interactStore.removePushSubscription(
            member.id,
            body.endpoint || url.searchParams.get("endpoint") || "",
          );
          return json({ ok: true });
        }
        throw new HttpError(405, "Method not allowed");
      }

      const shareMatch = /^\/api\/archives\/([^/]+)\/share$/.exec(path);
      if (shareMatch) {
        const doc = await catalog.document(shareMatch[1]);
        if (!doc || doc.deleting || doc.scope !== member.id) {
          throw new HttpError(404, "Document not found");
        }
        if (request.method === "POST") {
          if (doc.share_token) {
            return json({
              id: doc.id,
              name: doc.name,
              title: doc.title,
              folder: doc.folder,
              shared: true,
              shareUrl: `${base}/s/${doc.share_token}/`,
              sharedAt: doc.shared_at || null,
            });
          }
          const token = randomHex(12);
          const sharedAt = new Date().toISOString();
          await db.batch([
            {
              sql: "UPDATE documents SET share_token = ?, shared_at = ? WHERE id = ? AND deleting = 0 AND share_token IS NULL",
              values: [token, sharedAt, doc.id],
            },
          ]);
          const updated = await catalog.document(doc.id);
          if (!updated || updated.deleting || !updated.share_token) {
            throw new HttpError(404, "Document not found");
          }
          notify(updated);
          return json({
            id: updated.id,
            name: updated.name,
            title: updated.title,
            folder: updated.folder,
            shared: true,
            shareUrl: `${base}/s/${updated.share_token}/`,
            sharedAt: updated.shared_at || null,
          });
        }
        if (request.method === "DELETE") {
          await db.batch([
            {
              sql: "UPDATE documents SET share_token = NULL, shared_at = NULL WHERE id = ? AND deleting = 0",
              values: [doc.id],
            },
          ]);
          const updated: Document = { ...doc, share_token: null, shared_at: null };
          notify(updated);
          return json({
            id: doc.id,
            name: doc.name,
            title: doc.title,
            folder: doc.folder,
            shared: false,
            shareUrl: null,
            sharedAt: null,
          });
        }
        throw new HttpError(405, "Method not allowed");
      }

      const archiveMatch = /^\/api\/archives\/([^/]+)$/.exec(path);
      if (archiveMatch) {
        const doc = await catalog.document(archiveMatch[1]);
        if (!doc || doc.scope !== member.id) {
          if (!doc && request.method === "DELETE" && await catalog.isFallenPage(archiveMatch[1], member.id)) {
            return json({ ok: true });
          }
          throw new HttpError(404, "Document not found");
        }
        if (request.method === "PATCH") {
          if (doc.deleting) throw new HttpError(409, "Document is being deleted");
          const input = await request.json<{
            folder?: string;
            title?: string;
          }>();
          const folder = input.folder === undefined ? doc.folder : validateFolder(input.folder);
          const title = input.title === undefined ? doc.title : validateTitle(input.title) || doc.title;
          await db.batch([
            {
              sql: "UPDATE documents SET folder = ?, title = ? WHERE id = ? AND deleting = 0",
              values: [folder, title, doc.id],
            },
          ]);
          const updatedDoc: Document = { ...doc, folder, title };
          notify(updatedDoc);
          return json(catalog.archive(updatedDoc, await catalog.versions(doc.id)));
        }
        if (request.method === "DELETE") {
          await db.batch([{ sql: "UPDATE documents SET deleting = 1 WHERE id = ?", values: [doc.id] }]);
          const deleting = await catalog.document(doc.id);
          if (!deleting) return json({ ok: true });
          const versions = await catalog.versions(deleting.id);
          for (const version of versions) {
            await removeFiles(version.storage_id, JSON.parse(version.files));
          }
          const [idHash, publicIdHash, shareTokenHash] = await Promise.all([
            hash(deleting.id),
            hash(deleting.public_id),
            deleting.share_token ? hash(deleting.share_token) : null,
          ]);
          await db.batch([
            {
              sql: `INSERT INTO page_tombstones (id_hash, public_id_hash, owner_id, share_token_hash)
                    SELECT ?, ?, scope, ? FROM documents WHERE id = ?`,
              values: [idHash, publicIdHash, shareTokenHash, deleting.id],
            },
            { sql: "DELETE FROM documents WHERE id = ?", values: [deleting.id] },
          ]);
          notify(doc);
          return json({ ok: true });
        }
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      if (error instanceof SyntaxError || error instanceof URIError) {
        return json({ error: "Invalid request" }, 400);
      }
      console.error("Request failed", error instanceof Error ? error.message : "Unknown error");
      return json({ error: "Storage unavailable; retry after checking the saved version" }, 503);
    }
  };
}
