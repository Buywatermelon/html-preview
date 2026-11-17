import { createApp } from "./app";
import { d1Database } from "./database";
import { S3Store, type StorageConfig } from "./storage";
import { requestCredential, type AuthConfig } from "./auth";
import type { HostPresenceInfo, PresenceSnapshot } from "./interact-types";
export { HtmlPreviewEvents } from "./events";

export interface Bindings extends StorageConfig, AuthConfig {
  DB: D1Database;
  EVENTS: DurableObjectNamespace;
  VAPID_PUBLIC_KEY?: string;
}

export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    return createApp({
      ...env,
      db: d1Database(env.DB),
      store: new S3Store(env),
      defer: promise => ctx.waitUntil(promise),
      async events(request, user) {
        const headers = new Headers(request.headers);
        const url = new URL(request.url);
        const rawRole = url.searchParams.get("role");
        const role = rawRole === "daemon" ? "daemon" : "browser";
        headers.set("X-Html-Preview-Credential", JSON.stringify(await requestCredential(request)));
        headers.set("X-Html-Preview-Role", role);
        const hostId = url.searchParams.get("host_id");
        const hostName = url.searchParams.get("host_name");
        const ver = url.searchParams.get("ver");
        if (hostId) headers.set("X-Html-Preview-Host-Id", hostId);
        if (hostName) headers.set("X-Html-Preview-Host-Name", hostName);
        if (ver) headers.set("X-Html-Preview-Daemon-Ver", ver);
        return env.EVENTS.getByName(user.id).fetch(new Request(request, { headers }));
      },
      async disconnect(id) {
        await env.EVENTS.getByName(id).fetch("https://html-preview/revalidate", { method: "POST" });
      },
      async presence(userId): Promise<PresenceSnapshot> {
        const res = await env.EVENTS.getByName(userId).fetch("https://html-preview/presence", {
          method: "GET",
        });
        if (!res.ok) {
          return { activeBrowserCount: 0, onlineHosts: [] };
        }
        return (await res.json()) as PresenceSnapshot;
      },
      async notify(users, event, notifyOpts) {
        const activeEntries: Array<readonly [string, number]> = [];
        const hostEntries: Array<readonly [string, HostPresenceInfo[]]> = [];

        await Promise.all(
          users.map(async id => {
            const headers = new Headers();
            if (notifyOpts?.targetRole) {
              headers.set("X-Html-Preview-Target-Role", notifyOpts.targetRole);
            }
            if (notifyOpts?.targetHostId) {
              headers.set("X-Html-Preview-Target-Host", notifyOpts.targetHostId);
            }
            const res = await env.EVENTS.getByName(id).fetch("https://html-preview/changed", {
              method: "POST",
              headers,
              body: event ? JSON.stringify(event) : undefined,
            });
            const count = Number(res.headers.get("X-Html-Preview-Active-Browsers") || "0") || 0;
            let hosts: HostPresenceInfo[] = [];
            const rawHosts = res.headers.get("X-Html-Preview-Online-Hosts");
            if (rawHosts) {
              try {
                hosts = JSON.parse(rawHosts) as HostPresenceInfo[];
              } catch {}
            }
            activeEntries.push([id, count] as const);
            hostEntries.push([id, hosts] as const);
          }),
        );

        return {
          activeBrowserCount: Object.fromEntries(activeEntries),
          onlineHosts: Object.fromEntries(hostEntries),
        };
      },
    })(request);
  },
};
