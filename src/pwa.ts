import type {
  InteractionEventKind,
  InteractionRecord,
  PushSubscriptionRecord,
} from "./interact-types";

const ICON_SVG_DATA_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 192 192'%3E%3Crect width='192' height='192' rx='40' fill='%230f172a'/%3E%3Cpath fill='none' stroke='%2360a5fa' stroke-width='14' stroke-linecap='round' stroke-linejoin='round' d='M66 56 30 96l36 40M126 56l36 40-36 40M108 44 84 148'/%3E%3C/svg%3E";

export function pwaManifestResponse(method = "GET"): Response {
  const manifest = {
    name: "html-preview 工作台",
    short_name: "html-preview",
    description: "审阅 Coding Agent 产出的 HTML、划词留痕并实时接收回复与新版本",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#0b0f17",
    theme_color: "#0f172a",
    icons: [
      {
        src: ICON_SVG_DATA_URI,
        sizes: "192x192 512x512",
        type: "image/svg+xml",
        purpose: "any maskable",
      },
    ],
  };
  return new Response(method === "HEAD" ? null : JSON.stringify(manifest, null, 2), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const SERVICE_WORKER_JS = `/* html-preview Mobile & Desktop PWA Service Worker (Web Push + Deep Link) */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {
    title: "html-preview Agent 更新",
    body: "收到新的 Agent 回复或页面版本",
    url: "/dashboard",
    tag: "hp-interact"
  };
  try {
    if (event.data) {
      payload = Object.assign(payload, event.data.json());
    }
  } catch {}
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      data: { url: payload.url || "/dashboard" }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/dashboard";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client && client.url.includes("/dashboard")) {
          client.postMessage({ type: "html-preview:push-open", url: targetUrl });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
`;

export function serviceWorkerResponse(method = "GET"): Response {
  return new Response(method === "HEAD" ? null : SERVICE_WORKER_JS, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "Service-Worker-Allowed": "/",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export interface WebPushNotificationPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  documentId: string;
  interactionId: string;
  kind: InteractionEventKind;
}

export function shouldTriggerWebPush(kind: InteractionEventKind): boolean {
  return (
    kind === "replied" ||
    kind === "version_linked" ||
    kind === "needs_attention" ||
    kind === "failed"
  );
}

export function buildWebPushPayload(
  docTitle: string,
  interaction: InteractionRecord,
  kind: InteractionEventKind,
): WebPushNotificationPayload | null {
  if (!shouldTriggerWebPush(kind)) return null;
  const vParam = interaction.resultVersion ? `&v=${interaction.resultVersion}` : "";
  const url = `/dashboard#html=${encodeURIComponent(interaction.documentId)}${vParam}&interaction=${encodeURIComponent(interaction.id)}`;
  let title = `html-preview · ${docTitle}`;
  let body = "";
  if (kind === "version_linked" && interaction.resultVersion) {
    title = `已生成 v${interaction.resultVersion} · ${docTitle}`;
    body = interaction.replyText
      ? interaction.replyText.slice(0, 120)
      : `Agent 已针对你的留痕更新 HTML 至 v${interaction.resultVersion}`;
  } else if (kind === "replied") {
    title = `Agent 已回复 · ${docTitle}`;
    body = (interaction.replyText || "点击查看详细答复").slice(0, 120);
  } else if (kind === "needs_attention") {
    title = `需关注 · ${docTitle}`;
    body = (interaction.errorMessage || "目标 Agent 会话需要人工确认").slice(0, 120);
  } else {
    title = `投递异常 · ${docTitle}`;
    body = (interaction.errorMessage || "点击查看详情或重试").slice(0, 120);
  }
  return {
    title,
    body,
    url,
    tag: `hp-int-${interaction.id}`,
    documentId: interaction.documentId,
    interactionId: interaction.id,
    kind,
  };
}

export type PushDispatcher = (
  subscriptions: PushSubscriptionRecord[],
  payload: WebPushNotificationPayload,
) => Promise<void>;
