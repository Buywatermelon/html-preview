import { expect, it } from "vitest";
import {
  injectSidebarBridge,
  isPresentationFullscreenMetrics,
  isSidebarToggleMessage,
  matchesShortcutKey,
  matchPreviewShortcut,
  parsePreviewBridgeMessage,
  parseSelectionBridgeMessage,
  sidebarBridgeScript,
} from "../src/sidebar-bridge";

it("injects sidebar and pure-HTML fullscreen shortcuts in capture phase, and handles inline script </body> safely", async () => {
  const page = "<html><body><h1>Hi</h1></body></html>";
  expect(await injectSidebarBridge(page)).toBe(
    "<html><body><h1>Hi</h1>" + sidebarBridgeScript + "</body></html>",
  );
  expect(await injectSidebarBridge("plain")).toBe("plain" + sidebarBridgeScript);

  // Must NOT corrupt inline <script> literals containing "</body>"
  const reportWithScriptLiteral =
    '<html><body><div id="app"></div><script>const tpl = "<div>fake </body></div>";</script></body></html>';
  expect(await injectSidebarBridge(reportWithScriptLiteral)).toBe(
    '<html><body><div id="app"></div><script>const tpl = "<div>fake </body></div>";</script>' +
      sidebarBridgeScript +
      "</body></html>",
  );

  // HTML with </html> but no </body> injects before </html>
  const htmlOnly = "<html><h1>No body tag</h1></html>";
  expect(await injectSidebarBridge(htmlOnly)).toBe(
    "<html><h1>No body tag</h1>" + sidebarBridgeScript + "</html>",
  );

  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'">`;
  const injected = await injectSidebarBridge(`<head>${csp}</head><body></body>`);
  expect(injected).toContain(sidebarBridgeScript);
  expect(injected).toMatch(/script-src 'sha256-[^']+'/);
  expect(injected).not.toContain("script-src 'none'");

  // Capture-phase window listener + isContentEditable (never false-matching contenteditable="false")
  expect(sidebarBridgeScript).toContain("window.addEventListener('keydown',");
  expect(sidebarBridgeScript).toContain("},true);");
  expect(sidebarBridgeScript).toContain("t.isContentEditable");
  expect(sidebarBridgeScript).toContain("input,textarea,select");
  expect(sidebarBridgeScript).not.toContain("[contenteditable]");
  expect(sidebarBridgeScript).toContain("mk(e,'i','KeyI',73)");
  expect(sidebarBridgeScript).toContain("html-preview:toggle-sidebar");
  expect(sidebarBridgeScript).toContain("html-preview:toggle-interact");
  expect(sidebarBridgeScript).toContain("html-preview:toggle-fullscreen");
  expect(sidebarBridgeScript).toContain("html-preview:exit-fullscreen");
  // Must NOT preventDefault on Cmd+Shift+F inside iframe so macOS Chrome native toolbar toggle can enter/exit unimpeded
  expect(sidebarBridgeScript).toContain(
    "if(mod&&!e.altKey&&e.shiftKey&&mk(e,'f','KeyF',70)){if(window!==topWin)topWin.postMessage({type:'html-preview:toggle-fullscreen'},'*');return;}",
  );
  expect(sidebarBridgeScript).not.toContain("toggle-zen");
  expect(sidebarBridgeScript).not.toContain("html-preview:theme");
});

it("matches Cmd/Ctrl+I across macOS English, CapsLock, Chinese IME (KeyI), Full-width, and Dvorak", () => {
  // Standard macOS Cmd+I
  expect(matchPreviewShortcut({ metaKey: true, key: "i", code: "KeyI" })).toBe("toggle-interact");
  // CapsLock ON
  expect(matchPreviewShortcut({ metaKey: true, key: "I", code: "KeyI" })).toBe("toggle-interact");
  // macOS Simplified Chinese Pinyin IME (key='Process', keyCode=229, code='KeyI')
  expect(
    matchPreviewShortcut({
      metaKey: true,
      key: "Process",
      code: "KeyI",
      keyCode: 229,
      isComposing: true,
    }),
  ).toBe("toggle-interact");
  // Full-width character mode ('ｉ' U+FF49, code='KeyI')
  expect(matchPreviewShortcut({ metaKey: true, key: "ｉ", code: "KeyI" })).toBe("toggle-interact");
  // Dvorak layout: physical KeyI produces 'c' (Cmd+C copy must NOT trigger toggle-interact!)
  expect(matchesShortcutKey({ key: "c", code: "KeyI" }, "i", "KeyI", 73)).toBe(false);
  expect(matchPreviewShortcut({ metaKey: true, key: "c", code: "KeyI" })).toBeNull();
  // Dvorak layout: physical KeyG produces 'i' (Cmd+I on Dvorak MUST trigger toggle-interact!)
  expect(matchPreviewShortcut({ metaKey: true, key: "i", code: "KeyG" })).toBe("toggle-interact");

  // Plain <input>/<select> allows Cmd+I (toggle-interact) while blocking Cmd+B / Escape
  expect(
    matchPreviewShortcut({ metaKey: true, key: "i", code: "KeyI" }, { inPlainInput: true }),
  ).toBe("toggle-interact");
  expect(
    matchPreviewShortcut({ metaKey: true, key: "b", code: "KeyB" }, { inPlainInput: true }),
  ).toBeNull();
  expect(matchPreviewShortcut({ key: "Escape" }, { inPlainInput: true })).toBeNull();

  // Rich contenteditable="true" preserves Cmd+I for italic
  expect(
    matchPreviewShortcut({ metaKey: true, key: "i", code: "KeyI" }, { inRichEditable: true }),
  ).toBeNull();

  // Escape during IME composition does not exit fullscreen or close drawer
  expect(matchPreviewShortcut({ key: "Escape", isComposing: true })).toBeNull();
  expect(matchPreviewShortcut({ key: "Escape", isComposing: false })).toBe("exit-fullscreen");
});

it("accepts bridge messages only from the current preview frame", () => {
  const frame = {};
  const other = {};
  expect(isSidebarToggleMessage({ type: "html-preview:toggle-sidebar" }, frame, frame)).toBe(true);
  expect(isSidebarToggleMessage({ type: "html-preview:toggle-sidebar" }, other, frame)).toBe(false);
  expect(isSidebarToggleMessage({ type: "html-preview:toggle-zen" }, frame, frame)).toBe(false);
  expect(isSidebarToggleMessage({ type: "html-preview:toggle-sidebar" }, frame, null)).toBe(false);

  expect(
    parsePreviewBridgeMessage({ type: "html-preview:toggle-interact" }, frame, frame),
  ).toBe("toggle-interact");
  expect(
    parsePreviewBridgeMessage({ type: "html-preview:toggle-interact" }, other, frame),
  ).toBeNull();
  expect(
    parsePreviewBridgeMessage({ type: "html-preview:toggle-fullscreen" }, frame, frame),
  ).toBe("toggle-fullscreen");
  expect(
    parsePreviewBridgeMessage({ type: "html-preview:exit-fullscreen" }, frame, frame),
  ).toBe("exit-fullscreen");
  expect(
    parsePreviewBridgeMessage({ type: "html-preview:toggle-fullscreen" }, other, frame),
  ).toBeNull();
  expect(
    parsePreviewBridgeMessage({ type: "html-preview:unknown" }, frame, frame),
  ).toBeNull();

  expect(
    parseSelectionBridgeMessage(
      {
        type: "html-preview:selection",
        anchor: {
          entryPath: "index.html",
          exact: "Key revenue grew 42%",
          prefix: "Q4 summary: ",
          suffix: " YoY.",
          elementSelector: "main > section#kpi > p",
        },
      },
      frame,
      frame,
    ),
  ).toEqual({
    matched: true,
    anchor: {
      entryPath: "index.html",
      exact: "Key revenue grew 42%",
      prefix: "Q4 summary: ",
      suffix: " YoY.",
      elementSelector: "main > section#kpi > p",
    },
  });
  expect(
    parseSelectionBridgeMessage({ type: "html-preview:selection", anchor: null }, frame, frame),
  ).toEqual({ matched: true, anchor: null });
  expect(
    parseSelectionBridgeMessage(
      { type: "html-preview:selection", anchor: { exact: "spoofed" } },
      other,
      frame,
    ),
  ).toEqual({ matched: false });
});

it("distinguishes Cmd+Shift+F presentation fullscreen from normal window and toolbar fullscreen", () => {
  // Normal windowed browser
  expect(
    isPresentationFullscreenMetrics({
      displayModeFullscreen: false,
      hasDomFullscreen: false,
      innerWidth: 1280,
      innerHeight: 720,
      outerWidth: 1280,
      screenWidth: 1512,
      screenHeight: 982,
    }),
  ).toBe(false);

  // macOS Fullscreen Space WITH Chrome tabs + URL bar visible ("exited Cmd+Shift+F" on 14" Notch MacBook:
  // ImmersiveModeControllerMac reports innerHeight=859 while screenHeight=982 -> missing 123px > 60px)
  expect(
    isPresentationFullscreenMetrics({
      displayModeFullscreen: true,
      hasDomFullscreen: false,
      innerWidth: 1512,
      innerHeight: 859,
      outerWidth: 1512,
      screenWidth: 1512,
      screenHeight: 982,
    }),
  ).toBe(false);

  // External 2K display WITH Chrome tabs + URL bar visible (missing 86px > 60px)
  expect(
    isPresentationFullscreenMetrics({
      displayModeFullscreen: true,
      hasDomFullscreen: false,
      innerWidth: 2560,
      innerHeight: 1354,
      outerWidth: 2560,
      screenWidth: 2560,
      screenHeight: 1440,
    }),
  ).toBe(false);

  // macOS Split View (half screen width)
  expect(
    isPresentationFullscreenMetrics({
      displayModeFullscreen: true,
      hasDomFullscreen: false,
      innerWidth: 756,
      innerHeight: 945,
      outerWidth: 756,
      screenWidth: 1512,
      screenHeight: 982,
    }),
  ).toBe(false);

  // macOS Chrome Immersive Presentation Mode (Cmd+Shift+F: tabs + URL bar hidden on 14" Notch MacBook, 37pt notch)
  expect(
    isPresentationFullscreenMetrics({
      displayModeFullscreen: true,
      hasDomFullscreen: false,
      innerWidth: 1512,
      innerHeight: 945,
      outerWidth: 1512,
      screenWidth: 1512,
      screenHeight: 982,
    }),
  ).toBe(true);

  // External 2K display in Cmd+Shift+F immersive fullscreen (0px missing)
  expect(
    isPresentationFullscreenMetrics({
      displayModeFullscreen: true,
      hasDomFullscreen: false,
      innerWidth: 2560,
      innerHeight: 1440,
      outerWidth: 2560,
      screenWidth: 2560,
      screenHeight: 1440,
    }),
  ).toBe(true);

  // Presentation Mode at 125% browser zoom on 14" Notch MacBook
  expect(
    isPresentationFullscreenMetrics({
      displayModeFullscreen: true,
      hasDomFullscreen: false,
      innerWidth: 1210,
      innerHeight: 756,
      outerWidth: 1512,
      screenWidth: 1512,
      screenHeight: 982,
    }),
  ).toBe(true);

  // Presentation Mode at 125% browser zoom WITH toolbar visible must still be false!
  expect(
    isPresentationFullscreenMetrics({
      displayModeFullscreen: true,
      hasDomFullscreen: false,
      innerWidth: 1210,
      innerHeight: 687,
      outerWidth: 1512,
      screenWidth: 1512,
      screenHeight: 982,
    }),
  ).toBe(false);

  // W3C Element Fullscreen
  expect(
    isPresentationFullscreenMetrics({
      displayModeFullscreen: true,
      hasDomFullscreen: true,
      innerWidth: 1512,
      innerHeight: 945,
      outerWidth: 1512,
      screenWidth: 1512,
      screenHeight: 982,
    }),
  ).toBe(true);
});
