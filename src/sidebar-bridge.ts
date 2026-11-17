export type PreviewBridgeAction =
  | "toggle-sidebar"
  | "toggle-interact"
  | "toggle-fullscreen"
  | "exit-fullscreen";

export interface SelectionDraftAnchor {
  entryPath: string;
  exact: string;
  prefix?: string;
  suffix?: string;
  elementSelector?: string;
}

export interface ShortcutKeyLike {
  key?: string;
  code?: string;
  keyCode?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

export function matchesShortcutKey(
  e: ShortcutKeyLike,
  expectedLowerKey: string,
  expectedCode: string,
  expectedKeyCode: number,
): boolean {
  const k = typeof e.key === "string" ? e.key : "";
  if (/^[a-zA-Z]$/.test(k)) {
    return k.toLowerCase() === expectedLowerKey;
  }
  return e.code === expectedCode || e.keyCode === expectedKeyCode;
}

export function matchPreviewShortcut(
  e: ShortcutKeyLike,
  opts?: { inPlainInput?: boolean; inRichEditable?: boolean },
): PreviewBridgeAction | null {
  const isMod = Boolean(e.ctrlKey || e.metaKey);
  if (isMod && !e.altKey && !e.shiftKey && matchesShortcutKey(e, "i", "KeyI", 73)) {
    if (opts?.inRichEditable) return null;
    return "toggle-interact";
  }
  if (opts?.inPlainInput || opts?.inRichEditable) {
    return null;
  }
  if (isMod && !e.altKey && !e.shiftKey && matchesShortcutKey(e, "b", "KeyB", 66)) {
    return "toggle-sidebar";
  }
  if (isMod && !e.altKey && Boolean(e.shiftKey) && matchesShortcutKey(e, "f", "KeyF", 70)) {
    return "toggle-fullscreen";
  }
  if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing) {
    return "exit-fullscreen";
  }
  return null;
}

export const sidebarBridgeScript =
  "<script>(function(){function mk(e,ch,cd,kc){var k=typeof e.key==='string'?e.key:'';if(/^[a-zA-Z]$/.test(k))return k.toLowerCase()===ch;return e.code===cd||e.keyCode===kc;}function navTop(openInt){var m=/^\\/p\\/([^/]+)(?:\\/v([1-9]\\d*))?(?:\\/|$)/.exec(location.pathname);if(!m)return false;location.assign('/dashboard'+(openInt?'?interact=1':'')+'#html='+encodeURIComponent(m[1])+(m[2]?'&v='+m[2]:''));return true;}window.addEventListener('keydown',function(e){var t=e.target;var rich=Boolean(t&&t.isContentEditable);var ed=Boolean(rich||(t&&t.closest&&t.closest('input,textarea,select')));var mod=Boolean(e.ctrlKey||e.metaKey);var topWin=window.top||parent;if(mod&&!e.altKey&&!e.shiftKey&&mk(e,'i','KeyI',73)){if(rich)return;e.preventDefault();e.stopPropagation();if(window===topWin){navTop(true);return;}topWin.postMessage({type:'html-preview:toggle-interact'},'*');return;}if(ed)return;if(mod&&!e.altKey&&!e.shiftKey&&mk(e,'b','KeyB',66)){e.preventDefault();e.stopPropagation();if(window===topWin){navTop(false);return;}topWin.postMessage({type:'html-preview:toggle-sidebar'},'*');return;}if(mod&&!e.altKey&&e.shiftKey&&mk(e,'f','KeyF',70)){if(window!==topWin)topWin.postMessage({type:'html-preview:toggle-fullscreen'},'*');return;}if(e.key==='Escape'&&!e.defaultPrevented&&!e.isComposing){if(window!==topWin)topWin.postMessage({type:'html-preview:exit-fullscreen'},'*');}},true);var tm=0,last='';function selPath(n){var el=n&&n.nodeType===1?n:n&&n.parentElement;if(!el||!el.tagName)return '';var parts=[];while(el&&el!==document.body&&parts.length<4){var s=el.tagName.toLowerCase();if(el.id){parts.unshift(s+'#'+el.id);break;}if(el.className&&typeof el.className==='string'){var c=el.className.trim().split(/\\s+/)[0];if(c)s+='.'+c;}parts.unshift(s);el=el.parentElement;}return parts.join(' > ').slice(0,200);}function emitSel(){var g=window.getSelection?window.getSelection():null;var txt=g?String(g.toString()||'').trim():'';if(!txt){if(last){last='';(window.top||parent).postMessage({type:'html-preview:selection',anchor:null},'*');}return;}if(txt===last)return;last=txt;var p='',sf='',sel='';try{if(g&&g.rangeCount>0){var r=g.getRangeAt(0);sel=selPath(r.commonAncestorContainer);var blk=(r.commonAncestorContainer.nodeType===1?r.commonAncestorContainer:r.commonAncestorContainer.parentElement);var full=blk&&blk.textContent?String(blk.textContent):'';var idx=full.indexOf(txt);if(idx>=0){p=full.slice(Math.max(0,idx-60),idx);sf=full.slice(idx+txt.length,idx+txt.length+60);}}}catch(_){}var ep=(location.pathname.split('/').pop()||'index.html');(window.top||parent).postMessage({type:'html-preview:selection',anchor:{entryPath:ep,exact:txt.slice(0,2000),prefix:p||undefined,suffix:sf||undefined,elementSelector:sel||undefined}},'*');}function sched(){clearTimeout(tm);tm=setTimeout(emitSel,180);}document.addEventListener('selectionchange',sched);document.addEventListener('mouseup',sched);document.addEventListener('touchend',sched,{passive:true});})();</script>";

const scriptBody = sidebarBridgeScript.slice(
  sidebarBridgeScript.indexOf(">") + 1,
  sidebarBridgeScript.lastIndexOf("</script>"),
);

function allowScript(directive: string, hash: string): string {
  const value = directive.replace(/\s+'none'(?=\s|$)/i, "");
  return value.includes(hash) ? value : `${value} ${hash}`;
}

export function allowSidebarScript(policy: string, hash: string): string {
  const parts = policy.split(";").map(part => part.trim()).filter(Boolean);
  const index = (name: string) => parts.findIndex(part => new RegExp(`^${name}(?:\\s|$)`, "i").test(part));
  const script = index("script-src");
  if (script >= 0) parts[script] = allowScript(parts[script], hash);
  else {
    const defaults = parts.find(part => /^default-src(?:\s|$)/i.test(part));
    parts.push(allowScript(defaults ? defaults.replace(/^default-src/i, "script-src") : "script-src", hash));
  }
  const element = index("script-src-elem");
  if (element >= 0) parts[element] = allowScript(parts[element], hash);
  return parts.join("; ");
}

export async function injectSidebarBridge(html: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scriptBody));
  const hash = `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
  const lower = html.toLowerCase();
  const lastBodyClose = lower.lastIndexOf("</body>");
  const lastHtmlClose = lower.lastIndexOf("</html>");
  const lastScriptClose = lower.lastIndexOf("</script>");
  let withScript: string;
  if (lastBodyClose >= 0 && lastBodyClose > lastScriptClose) {
    withScript = html.slice(0, lastBodyClose) + sidebarBridgeScript + html.slice(lastBodyClose);
  } else if (lastHtmlClose >= 0 && lastHtmlClose > lastScriptClose) {
    withScript = html.slice(0, lastHtmlClose) + sidebarBridgeScript + html.slice(lastHtmlClose);
  } else {
    withScript = html + sidebarBridgeScript;
  }
  return withScript.replace(
    /<meta\b[^>]*http-equiv=(["'])content-security-policy\1[^>]*>/gi,
    tag => tag.replace(/content=(["'])([\s\S]*?)\1/i, (_match, quote, policy) => `content=${quote}${allowSidebarScript(policy, hash)}${quote}`),
  );
}

export function parsePreviewBridgeMessage(
  data: unknown,
  source: unknown,
  frame: unknown,
): PreviewBridgeAction | null {
  if (frame == null || source !== frame || !data || typeof data !== "object") {
    return null;
  }
  const type = (data as { type?: unknown }).type;
  if (type === "html-preview:toggle-sidebar") return "toggle-sidebar";
  if (type === "html-preview:toggle-interact") return "toggle-interact";
  if (type === "html-preview:toggle-fullscreen") return "toggle-fullscreen";
  if (type === "html-preview:exit-fullscreen") return "exit-fullscreen";
  return null;
}

export function isSidebarToggleMessage(data: unknown, source: unknown, frame: unknown): boolean {
  return parsePreviewBridgeMessage(data, source, frame) === "toggle-sidebar";
}

export function parseSelectionBridgeMessage(
  data: unknown,
  source: unknown,
  frame: unknown,
): { matched: false } | { matched: true; anchor: SelectionDraftAnchor | null } {
  if (frame == null || source !== frame || !data || typeof data !== "object") {
    return { matched: false };
  }
  const obj = data as { type?: unknown; anchor?: unknown };
  if (obj.type !== "html-preview:selection") return { matched: false };
  if (obj.anchor == null || typeof obj.anchor !== "object") {
    return { matched: true, anchor: null };
  }
  const a = obj.anchor as Record<string, unknown>;
  const exact = typeof a.exact === "string" ? a.exact.trim().slice(0, 2000) : "";
  if (!exact) return { matched: true, anchor: null };
  return {
    matched: true,
    anchor: {
      entryPath:
        typeof a.entryPath === "string" && a.entryPath.trim()
          ? a.entryPath.trim().slice(0, 240)
          : "index.html",
      exact,
      prefix: typeof a.prefix === "string" ? a.prefix.slice(0, 160) : undefined,
      suffix: typeof a.suffix === "string" ? a.suffix.slice(0, 160) : undefined,
      elementSelector:
        typeof a.elementSelector === "string" ? a.elementSelector.slice(0, 240) : undefined,
    },
  };
}

export interface BrowserViewportMetrics {
  displayModeFullscreen: boolean;
  hasDomFullscreen: boolean;
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  screenWidth: number;
  screenHeight: number;
}

export function isPresentationFullscreenMetrics(m: BrowserViewportMetrics): boolean {
  if (!m.displayModeFullscreen) return false;
  if (m.hasDomFullscreen) return true;
  if (
    m.innerWidth <= 0 ||
    m.innerHeight <= 0 ||
    m.screenWidth <= 0 ||
    m.screenHeight <= 0
  ) {
    return false;
  }
  // Exclude macOS Split View (side-by-side windows in Fullscreen Space)
  if (m.outerWidth > 0 && Math.abs(m.outerWidth - m.screenWidth) > 32) {
    return false;
  }
  // Compare viewport height against physical screenHeight (NEVER window.outerHeight,
  // because macOS Chrome ImmersiveModeControllerMac shrinks outerHeight below the toolbar
  // when the toolbar is visible, which inverted outerHeight - innerHeight!).
  // - Cmd+Shift+F immersive fullscreen (Chrome tabs & URL bar hidden):
  //   missing height is 0px (external display) or ~32..44px (MacBook camera notch) -> <= 60px.
  // - Exited immersive fullscreen (Chrome tabs & URL bar visible, ~82..120px + notch):
  //   missing height is ~86px (external display) or ~123px (Notch MacBook) -> > 60px.
  const zoom = m.screenWidth / m.innerWidth;
  const missingScreenDip = m.screenHeight - m.innerHeight * zoom;
  return missingScreenDip >= -8 && missingScreenDip <= 60;
}
