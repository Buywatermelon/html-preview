import { CLIENT_CSS, CLIENT_JS } from "./client-bundle.generated";

export function assetResponse(path: string, method = "GET"): Response | undefined {
  if (path === "/assets/client.js") {
    return new Response(method === "HEAD" ? null : CLIENT_JS, {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (path === "/assets/client.css") {
    return new Response(method === "HEAD" ? null : CLIENT_CSS, {
      headers: {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return undefined;
}

export function renderDashboardHtml(oauthEnabled = true, devLogin = false): string {
  const oauth = oauthEnabled ? "1" : "0";
  const dev = devLogin ? "1" : "0";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f172a">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="hp-oauth" content="${oauth}">
<meta name="hp-dev-login" content="${dev}">
<title>html-preview</title>
<link rel="manifest" href="/manifest.webmanifest">
<script>try{const t=JSON.parse(localStorage.getItem("html-preview:theme")||'"system"');if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch{}</script>
<style>:root{color-scheme:light dark;background:#f8fafc;color:#0f172a}:root[data-theme="light"]{color-scheme:light;background:#f8fafc;color:#0f172a}:root[data-theme="dark"]{color-scheme:dark;background:#0b0f17;color:#f8fafc}@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;background:#0b0f17;color:#f8fafc}}html,body,#root{margin:0;height:100dvh;background:inherit;color:inherit}</style>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Cpath fill=%22none%22 stroke=%22%23475569%22 stroke-width=%222%22 d=%22m8 5-6 7 6 7m8-14 6 7-6 7M14 3l-4 18%22/%3E%3C/svg%3E">
<link rel="stylesheet" href="/assets/client.css">
</head>
<body>
<div id="root"></div>
<script type="module" src="/assets/client.js"></script>
</body>
</html>
`;
}

export function dashboardResponse(
  request: Request,
  oauthEnabled = true,
  devLogin = false,
): Response {
  const html = renderDashboardHtml(oauthEnabled, devLogin);
  return new Response(request.method === "HEAD" ? null : html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
    },
  });
}
