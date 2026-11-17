import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const appSrc = readFileSync(new URL("../frontend/src/App.tsx", import.meta.url), "utf8");

it("removes team scope and dialogs from dashboard workspace", () => {
  expect(appSrc).toContain('fetch("/api/catalog")');
  expect(appSrc).not.toContain("scope=team");
  expect(appSrc).not.toContain("MembersDialog");
  expect(appSrc).not.toContain("TeamStorageDialog");
  expect(appSrc).not.toContain("./catalogLoad");
  expect(appSrc).not.toContain("catalogLoads");
  expect(appSrc).not.toContain("--scope");
  expect(appSrc).not.toContain("team-workspace-bar");
});

it("triggers initial catalog load once per currentUser without depending on written state", () => {
  const start = appSrc.indexOf("void loadCatalogRef.current(false);");
  expect(start).toBeGreaterThan(-1);
  const effectStart = appSrc.lastIndexOf("useEffect(() => {", start);
  const effectEnd = appSrc.indexOf("]);", start);
  const effectBlock = appSrc.slice(effectStart, effectEnd + 3);

  expect(effectBlock).toContain("}, [currentUser]);");
  expect(effectBlock).not.toContain("catalogLoaded");
  expect(effectBlock).not.toContain("archives");
  expect(effectBlock).not.toContain("selectedId");

  const loadStart = appSrc.indexOf("const loadCatalog = useCallback(");
  const loadEnd = appSrc.indexOf("const loadCatalogRef =", loadStart);
  const loadBlock = appSrc.slice(loadStart, loadEnd);
  expect(loadBlock).toContain("[currentUser, toast, userStorageKey]");
  expect(loadBlock).not.toMatch(/\[[^\]]*(catalogLoaded|archives|selectedId)[^\]]*\]/);
});

it("cleans up visibilitychange and focus wake listeners on unmount", () => {
  expect(appSrc).toContain('document.addEventListener("visibilitychange", onWake)');
  expect(appSrc).toContain('window.addEventListener("focus", onWake)');
  expect(appSrc).toContain('document.removeEventListener("visibilitychange", onWake)');
  expect(appSrc).toContain('window.removeEventListener("focus", onWake)');
  expect(appSrc).not.toMatch(
    /removeEventListener\("visibilitychange", onWake\);\n\s*window\.addEventListener\("focus", onWake\)/,
  );
});

it("keeps a single simplified public share UI in topbar without redundant descriptions or duplicate entries", () => {
  expect(appSrc).toContain('id="btn-share-create"');
  expect(appSrc).toContain('id="btn-share-manage"');
  expect(appSrc).toContain('id="share-popover"');
  expect(appSrc).toContain('id="share-url-text"');
  expect(appSrc).toContain('id="btn-unshare"');
  expect(appSrc).toContain("已复制公开链接");
  expect(appSrc).toContain("已取消公开");

  expect(appSrc).not.toContain(">复制公开链接<");
  expect(appSrc).not.toContain('label="复制公开链接"');
  expect(appSrc).not.toContain("公开并复制链接");
  expect(appSrc).not.toContain("打开公开页");
  expect(appSrc).not.toContain("公开分享已开启");
  expect(appSrc).not.toContain("跟随最新版");
  expect(appSrc).not.toContain("无需登录即可通过此链接");
  expect(appSrc).not.toContain("取消后此链接立即返回 404");
  expect(appSrc).not.toContain("已取消公开，原分享链接已立即失效");
});
