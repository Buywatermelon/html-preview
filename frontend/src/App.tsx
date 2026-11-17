import type { AcpClientFrame } from "../../src/acp-types";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import {
  DropdownMenu,
  DropdownMenuDivider,
  DropdownMenuItem,
} from "@astryxdesign/core/DropdownMenu";
import { IconButton } from "@astryxdesign/core/IconButton";
import { LayerProvider } from "@astryxdesign/core/Layer";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Stack } from "@astryxdesign/core/Stack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Theme } from "@astryxdesign/core/theme";
import { useToast } from "@astryxdesign/core/Toast";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileCodeSvgIcon,
  FolderSvgIcon,
  KeySvgIcon,
  LogOutSvgIcon,
  MonitorSvgIcon,
  MoonSvgIcon,
  MoreHorizontalIcon,
  PanelLeftIcon,
  RefreshSvgIcon,
  SearchSvgIcon,
  SunSvgIcon,
} from "./icons";
import {
  isPresentationFullscreenMetrics,
  matchesShortcutKey,
  parsePreviewBridgeMessage,
  parseSelectionBridgeMessage,
} from "../../src/sidebar-bridge";
import {
  BellSvgIcon,
  InteractDrawer,
  MessageSquareIcon,
  inspectBrowserPushStatus,
  isMacPlatform,
  toggleBrowserPushSubscription,
  type InteractBadgeCounts,
} from "./InteractDrawer";
import { LoginView } from "./LoginView";
import type {
  ArchiveItem,
  CatalogResponse,
  CreateDeviceTokenResponse,
  DeviceApproveResponse,
  DeviceTokenItem,
  DeviceTokensResponse,
  DeviceVerificationInfo,
  ProjectItem,
  RealtimeDrawerMessage,
  SelectionAnchor,
  SessionResponse,
  SessionUser,
  ShareResponse,
  ThemePreference,
  UploadEvent,
} from "./types";

const DEFAULT_SIDEBAR_WIDTH = 288;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 600;

const zhCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

export function compareArchives(a: ArchiveItem, b: ArchiveItem): number {
  const byTitle = zhCollator.compare(a.title, b.title);
  if (byTitle !== 0) return byTitle;
  return (b.updatedAt || "").localeCompare(a.updatedAt || "");
}

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function parseFolder(folder?: string | null): { project: string; task: string } | null {
  if (!folder || folder === "uncategorized") return null;
  const parts = folder.split("/");
  return { project: parts[0], task: parts[1] || "默认任务" };
}

function resolveShareUrl(raw?: string | null): string | null {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  return location.origin + (raw.startsWith("/") ? raw : `/${raw}`);
}

function normalizeDeviceUserCode(raw: string): string {
  const compact = raw.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (/^[A-Z0-9]{8}$/.test(compact)) {
    return `${compact.slice(0, 4)}-${compact.slice(4)}`;
  }
  return raw.trim().toUpperCase();
}

function formatDateTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function detectBrowserPresentationFullscreen(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return isPresentationFullscreenMetrics({
    displayModeFullscreen: window.matchMedia("(display-mode: fullscreen)").matches,
    hasDomFullscreen: typeof document !== "undefined" && Boolean(document.fullscreenElement),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    screenWidth: window.screen?.width ?? 0,
    screenHeight: window.screen?.height ?? 0,
  });
}

function WorkspaceInner({
  themePref,
  onThemeChange,
}: {
  themePref: ThemePreference;
  onThemeChange: (mode: ThemePreference) => void;
}) {
  const toast = useToast();

  const [authChecked, setAuthChecked] = useState(false);
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(null);
  const [signedOut, setSignedOut] = useState(
    () => new URLSearchParams(location.search).get("signed_out") === "1"
  );

  const [archives, setArchives] = useState<ArchiveItem[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState<boolean>(false);

  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const fromHash = new URLSearchParams(location.hash.slice(1)).get("html");
    return fromHash || null;
  });
  const [selectedVersion, setSelectedVersion] = useState<number | null>(() => {
    const v = Number(new URLSearchParams(location.hash.slice(1)).get("v"));
    return v > 0 ? v : null;
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [iframeReloadTick, setIframeReloadTick] = useState(0);
  const [loadedIframeKeys, setLoadedIframeKeys] = useState<Set<string>>(() => new Set());
  const [iframePool, setIframePool] = useState<
    Array<{ key: string; src: string; title: string }>
  >([]);
  const [lastReadyIframeKey, setLastReadyIframeKey] = useState<string | null>(null);
  const [showDelayedSpinner, setShowDelayedSpinner] = useState(false);

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() =>
    readStorage("html-preview:sidebar-collapsed", false)
  );
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(readStorage("html-preview:sidebar-width", DEFAULT_SIDEBAR_WIDTH));
    return Number.isFinite(saved)
      ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, saved))
      : DEFAULT_SIDEBAR_WIDTH;
  });
  const [isResizing, setIsResizing] = useState(false);
  const [domFullscreen, setDomFullscreen] = useState<boolean>(
    () => typeof document !== "undefined" && Boolean(document.fullscreenElement)
  );
  const [browserPresentationFullscreen, setBrowserPresentationFullscreen] =
    useState<boolean>(() => detectBrowserPresentationFullscreen());
  const [manualFullscreen, setManualFullscreen] = useState(false);

  const [devicesDialogOpen, setDevicesDialogOpen] = useState(false);
  const [deviceTokens, setDeviceTokens] = useState<DeviceTokenItem[]>([]);
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [tokensError, setTokensError] = useState<string | null>(null);
  const [revokingTokenId, setRevokingTokenId] = useState<string | null>(null);
  const [ciTokenName, setCiTokenName] = useState("");
  const [creatingCiToken, setCreatingCiToken] = useState(false);
  const [newlyCreatedToken, setNewlyCreatedToken] = useState<{
    token: string;
    name: string;
  } | null>(null);
  const [manualDeviceCode, setManualDeviceCode] = useState("");

  const [deviceApprovalOpen, setDeviceApprovalOpen] = useState(false);
  const [deviceApprovalCode, setDeviceApprovalCode] = useState("");
  const [deviceApprovalLoading, setDeviceApprovalLoading] = useState(false);
  const [deviceApprovalInfo, setDeviceApprovalInfo] =
    useState<DeviceVerificationInfo | null>(null);
  const [deviceApprovalError, setDeviceApprovalError] = useState<string | null>(
    null
  );
  const [deviceApprovalSubmitting, setDeviceApprovalSubmitting] = useState<
    "approve" | "deny" | null
  >(null);
  const [deviceApprovalResult, setDeviceApprovalResult] = useState<
    "approved" | "denied" | null
  >(null);

  const [sharePopoverOpen, setSharePopoverOpen] = useState(false);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [copiedShareFeedback, setCopiedShareFeedback] = useState(false);

  const [editorModal, setEditorModal] = useState<{
    mode: "move" | "rename";
    archive: ArchiveItem;
  } | null>(null);
  const [editorProject, setEditorProject] = useState("");
  const [editorMoveTask, setEditorMoveTask] = useState("");
  const [editorName, setEditorName] = useState("");
  const [editorSaving, setEditorSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ArchiveItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [dragOverArchiveId, setDragOverArchiveId] = useState<string | null>(null);

  const [isInteractOpen, setIsInteractOpen] = useState<boolean>(
    () =>
      Boolean(new URLSearchParams(location.hash.slice(1)).get("interaction")) ||
      new URLSearchParams(location.search).get("interact") === "1"
  );
  const [highlightedInteractionId, setHighlightedInteractionId] = useState<
    string | null
  >(() => new URLSearchParams(location.hash.slice(1)).get("interaction") || null);
  const [selectionAnchor, setSelectionAnchor] =
    useState<SelectionAnchor | null>(null);
  const [interactBadge, setInteractBadge] = useState<InteractBadgeCounts>({
    workingCount: 0,
    unreadCount: 0,
  });
  const [interactFocusTick, setInteractFocusTick] = useState(() =>
    new URLSearchParams(location.search).get("interact") === "1" ? 1 : 0
  );
  const [pushSupported, setPushSupported] = useState(false);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const isMac = useMemo(() => isMacPlatform(), []);
  const interactShortcutLabel = isMac ? "⌘I" : "Ctrl+I";
  const [wsReconnectTick, setWsReconnectTick] = useState(0);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const sharePopoverRef = useRef<HTMLDivElement | null>(null);
  const shareManageBtnRef = useRef<HTMLButtonElement | null>(null);
  const shareCreateBtnRef = useRef<HTMLButtonElement | null>(null);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedOnceRef = useRef(false);
  const archivesRef = useRef<ArchiveItem[]>([]);
  archivesRef.current = archives;
  const realtimeSocketRef = useRef<WebSocket | null>(null);
  const interactWsSubRef = useRef<
    ((msg: RealtimeDrawerMessage) => void) | null
  >(null);
  const isInteractReadingOrTypingRef = useRef(false);
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  const isInteractOpenRef = useRef<boolean>(isInteractOpen);
  isInteractOpenRef.current = isInteractOpen;
  const selectedVersionRef = useRef<number | null>(selectedVersion);
  selectedVersionRef.current = selectedVersion;
  const activeVersionRef = useRef<number | null>(null);

  const userStorageKey = useCallback(
    (key: string) => `html-preview:${currentUser?.id || "anon"}:${key}`,
    [currentUser?.id]
  );

  const checkSession = useCallback(async () => {
    try {
      const res = await fetch("/api/session");
      if (!res.ok) throw new Error("会话检查失败");
      const data: SessionResponse = await res.json();
      const rawUser = data.user;
      if (data.authenticated && rawUser) {
        const mergedUser: SessionUser = {
          id: rawUser.id,
          login: rawUser.login,
          github_id: rawUser.github_id,
          avatarUrl: rawUser.avatarUrl,
        };
        setCurrentUser(mergedUser);
        setSignedOut(false);
        try {
          localStorage.setItem("html-preview:identity", mergedUser.id);
        } catch {}
      } else {
        setCurrentUser(null);
      }
    } catch {
      setCurrentUser(null);
    } finally {
      setAuthChecked(true);
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  useEffect(() => {
    if (!currentUser) return;
    void inspectBrowserPushStatus().then((st) => {
      setPushSupported(st.supported);
      setPushSubscribed(st.subscribed);
    });
  }, [currentUser?.id]);

  const handleTogglePush = useCallback(async () => {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      const res = await toggleBrowserPushSubscription();
      setPushSubscribed(res.subscribed);
      toast({ body: res.message, type: "info" });
    } catch (err: any) {
      toast({
        body: err?.message || "设置离线推送失败",
        type: "error",
      });
    } finally {
      setPushBusy(false);
    }
  }, [pushBusy, toast]);

  const loadDeviceTokens = useCallback(async () => {
    setLoadingTokens(true);
    setTokensError(null);
    try {
      const res = await fetch("/api/auth/tokens");
      if (res.status === 401) {
        setCurrentUser(null);
        return;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "加载设备与令牌列表失败");
      }
      const data: DeviceTokensResponse | DeviceTokenItem[] = await res.json();
      const list = Array.isArray(data) ? data : data.tokens || [];
      setDeviceTokens(list.filter((item) => !item.revokedAt));
    } catch (err: any) {
      setTokensError(err.message || "加载设备与令牌列表失败");
    } finally {
      setLoadingTokens(false);
    }
  }, []);

  const openDevicesDialog = useCallback(() => {
    setDevicesDialogOpen(true);
    setTokensError(null);
    void loadDeviceTokens();
  }, [loadDeviceTokens]);

  const handleDevicesDialogOpenChange = useCallback((open: boolean) => {
    setDevicesDialogOpen(open);
    if (!open) {
      setNewlyCreatedToken(null);
      setManualDeviceCode("");
      setTokensError(null);
    }
  }, []);

  const openDeviceApproval = useCallback(async (rawCode: string) => {
    const normalized = normalizeDeviceUserCode(rawCode);
    if (!normalized) return;
    setDeviceApprovalCode(normalized);
    setDeviceApprovalOpen(true);
    setDeviceApprovalLoading(true);
    setDeviceApprovalError(null);
    setDeviceApprovalInfo(null);
    setDeviceApprovalResult(null);
    try {
      const res = await fetch(
        `/api/auth/device?user_code=${encodeURIComponent(normalized)}`
      );
      if (res.status === 401) {
        setDeviceApprovalOpen(false);
        setCurrentUser(null);
        return;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(
          errData.error || "设备验证码无效或已过期，请在终端重新发起登录。"
        );
      }
      const raw = await res.json();
      const info: DeviceVerificationInfo = {
        userCode: raw.userCode || raw.user_code || normalized,
        clientName: raw.clientName || raw.client_name || "CLI 设备",
        status: raw.status || "pending",
        expiresAt: raw.expiresAt || raw.expires_at || "",
      };
      setDeviceApprovalInfo(info);
    } catch (err: any) {
      setDeviceApprovalError(
        err.message || "设备验证码无效或已过期，请在终端重新发起登录。"
      );
    } finally {
      setDeviceApprovalLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    const searchParams = new URLSearchParams(location.search);
    const urlDeviceCode = searchParams.get("device_code")?.trim();
    const openInteractFromQuery = searchParams.get("interact") === "1";
    if (!urlDeviceCode && !openInteractFromQuery) return;
    searchParams.delete("device_code");
    searchParams.delete("interact");
    searchParams.delete("signed_out");
    searchParams.delete("auth_error");
    const restSearch = searchParams.toString();
    history.replaceState(
      null,
      "",
      location.pathname +
        (restSearch ? `?${restSearch}` : "") +
        (location.hash || "")
    );
    if (openInteractFromQuery) {
      setIsInteractOpen(true);
      setInteractFocusTick((t) => t + 1);
    }
    if (urlDeviceCode) {
      void openDeviceApproval(urlDeviceCode);
    }
  }, [currentUser, openDeviceApproval]);

  useEffect(() => {
    if (!currentUser) return;
    const savedFolders = readStorage<string[]>(userStorageKey("folders"), []);
    setCollapsedFolders(new Set(savedFolders));
    const hashParams = new URLSearchParams(location.hash.slice(1));
    if (!hashParams.get("html")) {
      setSelectedId(
        (prev) => prev ?? readStorage<string | null>(userStorageKey("selected"), null)
      );
    } else if (window.matchMedia("(max-width: 680px)").matches) {
      setIsSidebarCollapsed(true);
    }
  }, [currentUser, userStorageKey]);

  useEffect(() => {
    setSharePopoverOpen(false);
    setCopiedShareFeedback(false);
    if (copyFeedbackTimerRef.current) {
      clearTimeout(copyFeedbackTimerRef.current);
      copyFeedbackTimerRef.current = null;
    }
  }, [selectedId]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!sharePopoverOpen) return;

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (sharePopoverRef.current?.contains(target)) return;
      if (shareManageBtnRef.current?.contains(target)) return;
      if (shareCreateBtnRef.current?.contains(target)) return;
      setSharePopoverOpen(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setSharePopoverOpen(false);
      }
    };

    const onWindowBlur = () => {
      if (document.activeElement?.tagName === "IFRAME") {
        setSharePopoverOpen(false);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [sharePopoverOpen]);

  const revealArchiveFolder = useCallback(
    (item?: ArchiveItem | null) => {
      if (!item) return;
      setCollapsedFolders((prev) => {
        const next = new Set(prev);
        const f = parseFolder(item.folder);
        if (f) {
          next.delete(`p:${f.project}`);
          next.delete(`t:${f.project}/${f.task}`);
        } else {
          next.delete("uncategorized");
        }
        writeStorage(userStorageKey("folders"), [...next]);
        return next;
      });
    },
    [userStorageKey]
  );

  const loadCatalog = useCallback(
    async (silent = false) => {
      if (!currentUser) return;
      if (!silent) setLoadingCatalog(true);
      try {
        const res = await fetch("/api/catalog");
        if (res.status === 401) {
          setCurrentUser(null);
          return;
        }
        if (!res.ok) throw new Error("目录加载失败");
        const data: CatalogResponse = await res.json();
        const nextArchives = (data.archives || []).slice().sort(compareArchives);
        setArchives(nextArchives);
        setCatalogLoaded(true);

        setSelectedId((prevId) => {
          const hashId = !loadedOnceRef.current
            ? new URLSearchParams(location.hash.slice(1)).get("html")
            : null;
          const savedId = readStorage<string | null>(
            userStorageKey("selected"),
            null
          );
          const candidate = hashId || prevId || savedId;
          const matched = candidate
            ? nextArchives.find(
                (a) => a.id === candidate || a.publicId === candidate
              )
            : undefined;
          const resolved = matched?.id || nextArchives[0]?.id || null;
          return prevId === resolved ? prevId : resolved;
        });
        loadedOnceRef.current = true;
      } catch (err: any) {
        if (!silent) {
          toast({ body: err.message || "目录同步失败", type: "error" });
        }
      } finally {
        if (!silent) setLoadingCatalog(false);
      }
    },
    [currentUser, toast, userStorageKey]
  );

  const loadCatalogRef = useRef(loadCatalog);
  loadCatalogRef.current = loadCatalog;

  useEffect(() => {
    if (!currentUser) return;
    void loadCatalogRef.current(false);
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingInterval: ReturnType<typeof setInterval> | null = null;
    let delay = 1000;
    let unmounted = false;

    const connect = () => {
      if (unmounted) return;
      const proto = location.protocol === "https:" ? "wss://" : "ws://";
      const socket = new WebSocket(`${proto}${location.host}/api/events`);
      ws = socket;
      realtimeSocketRef.current = socket;

      socket.onopen = () => {
        if (unmounted) return;
        delay = 1000;
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send("ping");
          }
        }, 22000);
      };

      socket.onmessage = (event) => {
        if (event.data === "connected" || event.data === "changed") {
          void loadCatalogRef.current(true);
          if (event.data === "connected") {
            setWsReconnectTick((t) => t + 1);
          }
          return;
        }
        if (event.data === "pong") return;
        try {
          const parsedMsg = JSON.parse(event.data) as
            | UploadEvent
            | RealtimeDrawerMessage;
          if (parsedMsg.type === "upload") {
            const upload = parsedMsg;
            if (
              upload.id === selectedIdRef.current &&
              isInteractReadingOrTypingRef.current &&
              selectedVersionRef.current === null &&
              activeVersionRef.current
            ) {
              setSelectedVersion(activeVersionRef.current);
            }
            void loadCatalogRef.current(true);
            const prefix = upload.version === 1 ? "新上传 HTML" : "HTML 新版本";
            let dismissToast: (() => void) | null = null;
            dismissToast = toast({
              body: `${prefix}：${upload.title} (v${upload.version})`,
              type: "info",
              autoHideDuration: 8000,
              endContent: (
                <Button
                  size="sm"
                  variant="secondary"
                  label="查看"
                  onClick={() => {
                    setSelectedId(upload.id);
                    setSelectedVersion(null);
                    if (window.matchMedia("(max-width: 680px)").matches) {
                      setIsSidebarCollapsed(true);
                    }
                    const found = archivesRef.current.find((a) => a.id === upload.id);
                    if (found) revealArchiveFolder(found);
                    dismissToast?.();
                  }}
                />
              ),
            });
          } else if (parsedMsg.type === "interaction") {
            const intMsg = parsedMsg;
            if (
              (intMsg.kind === "version_linked" ||
                Boolean(intMsg.interaction?.resultVersion)) &&
              intMsg.documentId === selectedIdRef.current &&
              isInteractReadingOrTypingRef.current &&
              selectedVersionRef.current === null &&
              activeVersionRef.current
            ) {
              setSelectedVersion(activeVersionRef.current);
            }
            if (
              intMsg.kind === "version_linked" ||
              Boolean(intMsg.interaction?.resultVersion)
            ) {
              void loadCatalogRef.current(true);
            }
            interactWsSubRef.current?.(intMsg);

            const isAlreadyViewingThisThread =
              isInteractOpenRef.current &&
              intMsg.documentId === selectedIdRef.current;
            if (
              !isAlreadyViewingThisThread &&
              (intMsg.kind === "replied" ||
                intMsg.kind === "version_linked" ||
                intMsg.kind === "needs_attention" ||
                intMsg.kind === "failed")
            ) {
              const docTitle =
                archivesRef.current.find((a) => a.id === intMsg.documentId)
                  ?.title || "当前文档";
              const resVer = intMsg.interaction?.resultVersion;
              let bodyText = `Agent 更新：${docTitle}`;
              if (intMsg.kind === "version_linked" && resVer) {
                bodyText = `✨ 已生成 v${resVer}：${docTitle}`;
              } else if (intMsg.kind === "replied") {
                bodyText = `💬 Agent 已回复：${docTitle}`;
              } else if (intMsg.kind === "needs_attention") {
                bodyText = `需关注：${
                  intMsg.interaction?.errorMessage || docTitle
                }`;
              } else if (intMsg.kind === "failed") {
                bodyText = `投递异常：${
                  intMsg.interaction?.errorMessage || docTitle
                }`;
              }
              let dismissIntToast: (() => void) | null = null;
              dismissIntToast = toast({
                uniqueID: `int-${intMsg.interaction?.id || intMsg.seq}`,
                body: bodyText,
                type:
                  intMsg.kind === "failed" || intMsg.kind === "needs_attention"
                    ? "error"
                    : "info",
                isAutoHide: true,
                autoHideDuration: 7000,
                endContent: (
                  <Button
                    size="sm"
                    variant="secondary"
                    label={resVer ? `看 v${resVer}` : "查看"}
                    onClick={() => {
                      setSelectedId(intMsg.documentId);
                      setSelectedVersion(resVer && resVer > 0 ? resVer : null);
                      if (intMsg.interaction?.id) {
                        setHighlightedInteractionId(intMsg.interaction.id);
                      }
                      setIsInteractOpen(true);
                      if (window.matchMedia("(max-width: 680px)").matches) {
                        setIsSidebarCollapsed(true);
                      }
                      const found = archivesRef.current.find(
                        (a) => a.id === intMsg.documentId
                      );
                      if (found) revealArchiveFolder(found);
                      dismissIntToast?.();
                    }}
                  />
                ),
              });
            }
          } else if (parsedMsg.type === "host_presence" || parsedMsg.type.startsWith("acp_")) {
            interactWsSubRef.current?.(parsedMsg);
          }
        } catch {}
      };

      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (realtimeSocketRef.current === socket) realtimeSocketRef.current = null;
        if (unmounted) return;
        if (pingInterval) clearInterval(pingInterval);
        reconnectTimer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 20000);
      };
    };

    connect();

    const onWake = () => {
      if (!document.hidden) {
        if (!ws || ws.readyState >= WebSocket.CLOSING) connect();
        void loadCatalogRef.current(true);
      }
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);

    return () => {
      unmounted = true;
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingInterval) clearInterval(pingInterval);
      ws?.close();
    };
  }, [currentUser, revealArchiveFolder, toast]);

  const selectedArchive = useMemo(
    () => archives.find((a) => a.id === selectedId) || null,
    [archives, selectedId]
  );

  const activeVersion = useMemo(() => {
    if (!selectedArchive) return null;
    const versions = selectedArchive.versions;
    if (selectedVersion && versions.some((v) => v.version === selectedVersion)) {
      return selectedVersion;
    }
    return versions.at(-1)?.version || 1;
  }, [selectedArchive, selectedVersion]);
  activeVersionRef.current = activeVersion;

  const latestVersion = selectedArchive?.versions.at(-1)?.version || 1;
  const isLatestVersion = activeVersion === latestVersion;
  const selectedShareUrl = resolveShareUrl(selectedArchive?.shareUrl);

  useEffect(() => {
    setSelectionAnchor(null);
  }, [selectedId, activeVersion]);

  useEffect(() => {
    if (
      !currentUser ||
      typeof navigator === "undefined" ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }
    void navigator.serviceWorker.register("/sw.js").catch(() => {});

    const onSwMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (
        !data ||
        data.type !== "html-preview:push-open" ||
        typeof data.url !== "string"
      ) {
        return;
      }
      try {
        const target = new URL(data.url, location.origin);
        const params = new URLSearchParams(target.hash.replace(/^#/, ""));
        const docId = params.get("html");
        const v = Number(params.get("v"));
        const intId = params.get("interaction");
        if (docId) {
          setSelectedId(docId);
          const found = archivesRef.current.find((a) => a.id === docId);
          if (found) revealArchiveFolder(found);
          else void loadCatalogRef.current(true);
        }
        setSelectedVersion(v > 0 ? v : null);
        if (intId) {
          setHighlightedInteractionId(intId);
        }
        setIsInteractOpen(true);
        if (window.matchMedia("(max-width: 680px)").matches) {
          setIsSidebarCollapsed(true);
        }
      } catch {}
    };

    navigator.serviceWorker.addEventListener("message", onSwMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", onSwMessage);
    };
  }, [currentUser, revealArchiveFolder]);

  const iframeSrc = useMemo(() => {
    if (!selectedArchive || !activeVersion) return null;
    const slug = encodeURIComponent(selectedArchive.publicId || selectedArchive.id);
    return `/p/${slug}/v${activeVersion}/?b=4`;
  }, [selectedArchive, activeVersion]);

  const iframeKey =
    selectedArchive && activeVersion
      ? `${selectedArchive.publicId}:${activeVersion}:${iframeReloadTick}`
      : null;

  const isCurrentIframeReady = Boolean(iframeKey && loadedIframeKeys.has(iframeKey));

  useEffect(() => {
    if (!iframeKey || !iframeSrc || !selectedArchive) return;
    const title = selectedArchive.title;
    setIframePool((prev) => {
      const existing = prev.find((item) => item.key === iframeKey);
      if (existing) {
        if (existing.title !== title || existing.src !== iframeSrc) {
          return prev.map((item) =>
            item.key === iframeKey ? { key: iframeKey, src: iframeSrc, title } : item
          );
        }
        return prev;
      }
      const next = [...prev, { key: iframeKey, src: iframeSrc, title }];
      if (next.length > 6) {
        const dropCandidate = next.find(
          (item) => item.key !== iframeKey && item.key !== lastReadyIframeKey
        );
        if (dropCandidate) {
          return next.filter((item) => item.key !== dropCandidate.key);
        }
      }
      return next;
    });
  }, [iframeKey, iframeSrc, selectedArchive, lastReadyIframeKey]);

  useEffect(() => {
    if (!iframeKey || isCurrentIframeReady) {
      setShowDelayedSpinner(false);
      return;
    }
    if (!lastReadyIframeKey) {
      setShowDelayedSpinner(true);
      return;
    }
    const timer = setTimeout(() => {
      setShowDelayedSpinner(true);
    }, 300);
    return () => clearTimeout(timer);
  }, [iframeKey, isCurrentIframeReady, lastReadyIframeKey]);

  useEffect(() => {
    if (!currentUser || !loadedOnceRef.current) return;
    if (selectedId) {
      writeStorage(userStorageKey("selected"), selectedId);
    }
    const params = new URLSearchParams();
    if (selectedId) params.set("html", selectedId);
    if (selectedId && activeVersion && !isLatestVersion) {
      params.set("v", String(activeVersion));
    }
    const qs = params.toString();
    const nextHash = qs ? "#" + qs : "";
    if (location.pathname === "/dashboard" && location.hash !== nextHash) {
      history.replaceState(null, "", "/dashboard" + location.search + nextHash);
    }
  }, [currentUser, selectedId, activeVersion, isLatestVersion, userStorageKey]);

  useEffect(() => {
    const onHashChange = () => {
      const params = new URLSearchParams(location.hash.slice(1));
      const htmlId = params.get("html");
      const intId = params.get("interaction");
      if (htmlId) {
        const found = archivesRef.current.find(
          (a) => a.id === htmlId || a.publicId === htmlId
        );
        setSelectedId(found ? found.id : htmlId);
        const v = Number(params.get("v"));
        setSelectedVersion(v > 0 ? v : null);
        if (window.matchMedia("(max-width: 680px)").matches) {
          setIsSidebarCollapsed(true);
        }
        if (found) {
          revealArchiveFolder(found);
        } else {
          void loadCatalogRef.current(true);
        }
      }
      if (intId) {
        setHighlightedInteractionId(intId);
        setIsInteractOpen(true);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [revealArchiveFolder]);

  const hasActivePreview = Boolean(selectedArchive && iframeSrc);
  const isFullscreen =
    hasActivePreview &&
    (domFullscreen || browserPresentationFullscreen || manualFullscreen);

  useEffect(() => {
    if (hasActivePreview) return;
    setManualFullscreen(false);
    if (typeof document !== "undefined" && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
  }, [hasActivePreview]);

  useEffect(() => {
    const onFullscreenChange = () => {
      const active = Boolean(document.fullscreenElement);
      setDomFullscreen(active);
      if (!active) {
        setManualFullscreen(false);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, []);

  useEffect(() => {
    const mql =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(display-mode: fullscreen)")
        : null;
    let prevDisplayFullscreen = Boolean(mql?.matches);
    let prevPresentation = detectBrowserPresentationFullscreen();
    setBrowserPresentationFullscreen(prevPresentation);

    const syncPresentation = () => {
      const nowDisplayFullscreen = Boolean(mql?.matches);
      if (nowDisplayFullscreen !== prevDisplayFullscreen) {
        // Clear any windowed manualFullscreen whenever entering/exiting OS Fullscreen Space
        // so manualFullscreen can never invert OS fullscreen state.
        setManualFullscreen(false);
        prevDisplayFullscreen = nowDisplayFullscreen;
      }
      const next = detectBrowserPresentationFullscreen();
      setBrowserPresentationFullscreen(next);
      if (next && !prevPresentation) {
        setSharePopoverOpen(false);
      } else if (!next && prevPresentation) {
        setManualFullscreen(false);
      }
      prevPresentation = next;
    };

    window.addEventListener("resize", syncPresentation);
    window.visualViewport?.addEventListener("resize", syncPresentation);
    mql?.addEventListener("change", syncPresentation);
    return () => {
      window.removeEventListener("resize", syncPresentation);
      window.visualViewport?.removeEventListener("resize", syncPresentation);
      mql?.removeEventListener("change", syncPresentation);
    };
  }, []);

  const exitPureFullscreen = useCallback(() => {
    setManualFullscreen(false);
    if (typeof document !== "undefined" && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
  }, []);

  const togglePureFullscreen = useCallback(() => {
    if (!hasActivePreview) return;
    if (Boolean(document.fullscreenElement) || manualFullscreen) {
      exitPureFullscreen();
      return;
    }
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: fullscreen)").matches
    ) {
      return;
    }
    setSharePopoverOpen(false);
    setManualFullscreen(true);
  }, [exitPureFullscreen, hasActivePreview, manualFullscreen]);

  const toggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((prev) => {
      const next = !prev;
      writeStorage("html-preview:sidebar-collapsed", next);
      return next;
    });
  }, []);

  const toggleInteract = useCallback(() => {
    if (!selectedIdRef.current) return;
    setSharePopoverOpen(false);
    setIsInteractOpen((prev) => {
      const next = !prev;
      if (next) {
        setInteractFocusTick((t) => t + 1);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const hasModalOpen =
      devicesDialogOpen ||
      deviceApprovalOpen ||
      editorModal !== null ||
      deleteTarget !== null;

    const resolvePreviewWindow = (source: MessageEventSource | null): Window | null => {
      if (!source) return null;
      const primary = iframeRef.current?.contentWindow ?? null;
      if (primary && source === primary) return primary;
      const container = canvasRef.current;
      if (!container) return null;
      const frames = container.querySelectorAll<HTMLIFrameElement>("iframe.hp-preview-iframe");
      for (const frame of frames) {
        if (frame.contentWindow && frame.contentWindow === source) {
          return frame.contentWindow;
        }
      }
      return null;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (hasModalOpen) return;
      const targetEl = e.target instanceof Element ? e.target : null;
      const htmlTarget = e.target instanceof HTMLElement ? e.target : null;
      const inRichEditable = Boolean(htmlTarget?.isContentEditable);
      const inPlainInput = Boolean(targetEl?.closest("input,textarea,select"));
      const inInput = inRichEditable || inPlainInput;
      const inInteractDrawer = Boolean(targetEl?.closest("#interact-drawer"));
      const isMod = e.ctrlKey || e.metaKey;

      if (
        isMod &&
        !e.altKey &&
        !e.shiftKey &&
        matchesShortcutKey(e, "i", "KeyI", 73) &&
        (!inRichEditable || inInteractDrawer)
      ) {
        e.preventDefault();
        e.stopPropagation();
        toggleInteract();
        return;
      }

      if (inInput) return;

      if (
        isMod &&
        !e.altKey &&
        !e.shiftKey &&
        matchesShortcutKey(e, "b", "KeyB", 66)
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (!isFullscreen) {
          toggleSidebar();
        }
        return;
      }

      if (
        isMod &&
        !e.altKey &&
        e.shiftKey &&
        matchesShortcutKey(e, "f", "KeyF", 70)
      ) {
        togglePureFullscreen();
        return;
      }

      if (
        e.key === "Escape" &&
        !e.defaultPrevented &&
        !e.isComposing &&
        !sharePopoverOpen
      ) {
        if (isInteractOpen) {
          setIsInteractOpen(false);
        } else if (manualFullscreen || document.fullscreenElement) {
          exitPureFullscreen();
        }
      }
    };

    const onMessage = (event: MessageEvent) => {
      const matchedFrame = resolvePreviewWindow(event.source);
      const sel = parseSelectionBridgeMessage(
        event.data,
        event.source,
        matchedFrame
      );
      if (sel.matched) {
        setSelectionAnchor(sel.anchor);
        return;
      }
      if (hasModalOpen) return;
      const action = parsePreviewBridgeMessage(
        event.data,
        event.source,
        matchedFrame
      );
      if (!action) return;
      if (action === "toggle-sidebar") {
        if (!isFullscreen) {
          toggleSidebar();
        }
      } else if (action === "toggle-interact") {
        toggleInteract();
      } else if (action === "toggle-fullscreen") {
        togglePureFullscreen();
      } else if (action === "exit-fullscreen") {
        if (isInteractOpen) {
          setIsInteractOpen(false);
        } else if (manualFullscreen || document.fullscreenElement) {
          exitPureFullscreen();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("message", onMessage);
    };
  }, [
    deleteTarget,
    deviceApprovalOpen,
    devicesDialogOpen,
    editorModal,
    exitPureFullscreen,
    isFullscreen,
    isInteractOpen,
    manualFullscreen,
    sharePopoverOpen,
    toggleInteract,
    togglePureFullscreen,
    toggleSidebar,
  ]);

  const startSidebarResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startW = sidebarWidth;
    setIsResizing(true);
    document.body.classList.add("hp-is-resizing");
    handle.setPointerCapture(e.pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const nextWidth = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, Math.round(startW + delta))
      );
      setSidebarWidth(nextWidth);
    };

    const onUp = (upEvent: PointerEvent) => {
      setIsResizing(false);
      document.body.classList.remove("hp-is-resizing");
      try {
        handle.releasePointerCapture(upEvent.pointerId);
      } catch {}
      const delta = upEvent.clientX - startX;
      const finalWidth = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, Math.round(startW + delta))
      );
      writeStorage("html-preview:sidebar-width", finalWidth);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  const resetSidebarWidth = () => {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    writeStorage("html-preview:sidebar-width", DEFAULT_SIDEBAR_WIDTH);
  };

  const toggleFolder = (folderKey: string) => {
    if (searchQuery.trim()) return;
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderKey)) next.delete(folderKey);
      else next.add(folderKey);
      writeStorage(userStorageKey("folders"), [...next]);
      return next;
    });
  };

  const triggerCopiedFeedback = useCallback(() => {
    setCopiedShareFeedback(true);
    if (copyFeedbackTimerRef.current) {
      clearTimeout(copyFeedbackTimerRef.current);
    }
    copyFeedbackTimerRef.current = setTimeout(() => {
      setCopiedShareFeedback(false);
      copyFeedbackTimerRef.current = null;
    }, 1600);
  }, []);

  const handleCopyShareUrl = async (
    rawUrl?: string | null,
    showBtnFeedback = false
  ) => {
    const url = resolveShareUrl(rawUrl);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      if (showBtnFeedback) triggerCopiedFeedback();
      toast({ body: "已复制公开链接", type: "info" });
    } catch {
      setSharePopoverOpen(true);
      toast({ body: "请手动复制公开链接", type: "info" });
    }
  };

  const handleShareArchive = async (archive: ArchiveItem) => {
    if (sharingId === archive.id) return;
    setSharingId(archive.id);
    try {
      const res = await fetch(
        `/api/archives/${encodeURIComponent(archive.id)}/share`,
        { method: "POST" }
      );
      if (res.status === 401) {
        setCurrentUser(null);
        return;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "公开失败");
      }
      const data: ShareResponse = await res.json();
      const finalShareUrl = resolveShareUrl(data.shareUrl);
      setArchives((prev) =>
        prev.map((item) =>
          item.id === archive.id
            ? {
                ...item,
                shared: Boolean(data.shared),
                shareUrl: finalShareUrl,
                sharedAt: data.sharedAt ?? new Date().toISOString(),
              }
            : item
        )
      );

      let copied = false;
      if (finalShareUrl && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(finalShareUrl);
          copied = true;
        } catch {
          copied = false;
        }
      }

      if (!copied) {
        setSharePopoverOpen(true);
      }

      toast({
        body: copied ? "已复制公开链接" : "已公开，请复制链接",
        type: "info",
      });
    } catch (err: any) {
      toast({ body: err.message || "公开失败", type: "error" });
    } finally {
      setSharingId((prev) => (prev === archive.id ? null : prev));
    }
  };

  const handleUnshareArchive = async (archive: ArchiveItem) => {
    if (sharingId === archive.id) return;
    setSharingId(archive.id);
    try {
      const res = await fetch(
        `/api/archives/${encodeURIComponent(archive.id)}/share`,
        { method: "DELETE" }
      );
      if (res.status === 401) {
        setCurrentUser(null);
        return;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "取消公开失败");
      }
      setArchives((prev) =>
        prev.map((item) =>
          item.id === archive.id
            ? { ...item, shared: false, shareUrl: null, sharedAt: null }
            : item
        )
      );
      if (archive.id === selectedId) {
        setSharePopoverOpen(false);
        setCopiedShareFeedback(false);
      }
      toast({ body: "已取消公开", type: "info" });
    } catch (err: any) {
      toast({ body: err.message || "取消公开失败", type: "error" });
    } finally {
      setSharingId((prev) => (prev === archive.id ? null : prev));
    }
  };

  const patchArchive = async (
    archiveId: string,
    patch: { folder?: string; title?: string },
    okMsg?: string
  ) => {
    try {
      const res = await fetch(`/api/archives/${encodeURIComponent(archiveId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("更新 HTML 属性失败");
      if (okMsg) toast({ body: okMsg, type: "info" });
      await loadCatalog(true);
    } catch (err: any) {
      toast({ body: err.message || "更新失败", type: "error" });
    }
  };

  const handleDropOnArchive = async (draggedId: string, targetItem: ArchiveItem) => {
    if (!draggedId || draggedId === targetItem.id) return;
    const draggedArchive = archives.find((a) => a.id === draggedId);
    if (!draggedArchive || draggedArchive.folder === targetItem.folder) return;
    await patchArchive(draggedId, { folder: targetItem.folder }, "已移动到目标任务");
  };

  const allExistingProjects = useMemo<ProjectItem[]>(() => {
    const map = new Map<string, Set<string>>();
    for (const item of archives) {
      const f = parseFolder(item.folder);
      if (!f) continue;
      if (!map.has(f.project)) map.set(f.project, new Set());
      map.get(f.project)!.add(f.task);
    }
    return Array.from(map.entries()).map(([name, tasks]) => ({
      name,
      tasks: Array.from(tasks),
    }));
  }, [archives]);

  const openEditorModal = (mode: "move" | "rename", archive: ArchiveItem) => {
    const f = parseFolder(archive.folder);
    const activeProj = f?.project || allExistingProjects[0]?.name || "";
    const tasksForProj =
      allExistingProjects.find((p) => p.name === activeProj)?.tasks || [];

    setEditorModal({ mode, archive });
    setEditorProject(activeProj);
    setEditorMoveTask(f?.task || tasksForProj[0] || "");
    setEditorName(archive.title || "");
  };

  const handleSaveEditor = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!editorModal) return;
    const { mode, archive } = editorModal;
    setEditorSaving(true);
    try {
      if (mode === "move") {
        const proj = editorProject.trim();
        const task = editorMoveTask.trim();
        if (!proj || !task) throw new Error("请输入目标项目与任务");
        await patchArchive(archive.id, { folder: `${proj}/${task}` }, "已移动到目标任务");
      } else if (mode === "rename") {
        const title = editorName.trim();
        if (!title) throw new Error("请输入文档标题");
        await patchArchive(archive.id, { folder: archive.folder, title }, "标题已更新");
      }
      setEditorModal(null);
    } catch (err: any) {
      toast({ body: err.message || "保存失败", type: "error" });
    } finally {
      setEditorSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/archives/${encodeURIComponent(deleteTarget.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("删除 HTML 失败");
      const deletedId = deleteTarget.id;
      setDeleteTarget(null);
      if (selectedId === deletedId) {
        setSharePopoverOpen(false);
        setSelectedId(null);
        setSelectedVersion(null);
      }
      toast({ body: "已删除", type: "info" });
      await loadCatalog(true);
    } catch (err: any) {
      toast({ body: err.message || "删除失败", type: "error" });
    } finally {
      setDeleting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/session", { method: "DELETE" });
    } catch {}
    try {
      localStorage.setItem("html-preview:identity", "");
    } catch {}
    loadedOnceRef.current = false;
    setArchives([]);
    setCatalogLoaded(false);
    setDevicesDialogOpen(false);
    setDeviceApprovalOpen(false);
    setNewlyCreatedToken(null);
    setDeviceTokens([]);
    setSharePopoverOpen(false);
    setCopiedShareFeedback(false);
    setIsInteractOpen(false);
    setSelectionAnchor(null);
    setHighlightedInteractionId(null);
    exitPureFullscreen();
    setCurrentUser(null);
    setSignedOut(true);
    history.replaceState(null, "", "/dashboard?signed_out=1");
  };

  const cycleTheme = () => {
    const order: ThemePreference[] = ["light", "dark", "system"];
    const next = order[(order.indexOf(themePref) + 1) % order.length];
    onThemeChange(next);
    const labelMap: Record<ThemePreference, string> = {
      light: "已切换为浅色模式",
      dark: "已切换为深色模式",
      system: "已切换为跟随系统外观",
    };
    toast({ body: labelMap[next] });
  };

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const matchesArchive = useCallback(
    (item: ArchiveItem) => {
      if (!normalizedQuery) return true;
      return [
        item.title,
        item.name,
        item.folder,
        ...item.versions.map((v) => v.note),
      ].some((s) => (s || "").toLowerCase().includes(normalizedQuery));
    },
    [normalizedQuery]
  );

  const projectTree = useMemo(() => {
    const projMap = new Map<string, Map<string, ArchiveItem[]>>();
    for (const item of archives) {
      if (!matchesArchive(item)) continue;
      const f = parseFolder(item.folder);
      if (!f) continue;
      if (!projMap.has(f.project)) {
        projMap.set(f.project, new Map());
      }
      const taskMap = projMap.get(f.project)!;
      if (!taskMap.has(f.task)) {
        taskMap.set(f.task, []);
      }
      taskMap.get(f.task)!.push(item);
    }
    return Array.from(projMap.entries()).map(([projName, taskMap]) => ({
      name: projName,
      tasks: Array.from(taskMap.entries()).map(([taskName, files]) => ({
        name: taskName,
        files: files.slice().sort(compareArchives),
      })),
    }));
  }, [archives, matchesArchive]);

  const uncategorizedArchives = useMemo(
    () =>
      archives
        .filter((a) => !parseFolder(a.folder) && matchesArchive(a))
        .sort(compareArchives),
    [archives, matchesArchive]
  );

  const sendRealtime = useCallback((frame: AcpClientFrame): boolean => {
    const socket = realtimeSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame)); return true;
  }, []);

  const subscribeRealtimeInteraction = useCallback(
    (fn: ((msg: RealtimeDrawerMessage) => void) | null) => {
      interactWsSubRef.current = fn;
    },
    []
  );

  const handleClearSelection = useCallback(() => {
    setSelectionAnchor(null);
  }, []);

  const handleClearHighlight = useCallback(() => {
    setHighlightedInteractionId(null);
  }, []);

  const handleRefreshCatalogSilent = useCallback(() => {
    void loadCatalogRef.current(true);
  }, []);

  const handleReadingOrTypingChange = useCallback((active: boolean) => {
    isInteractReadingOrTypingRef.current = active;
  }, []);

  if (!authChecked) {
    return (
      <div className="hp-loading-screen">
        <span className="hp-brand-code">&lt;/&gt;</span>
        <span>正在验证工作台会话…</span>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <LoginView
        signedOut={signedOut}
        onAuthenticated={checkSession}
      />
    );
  }

  const cliLoginCommand = `html-preview login ${location.origin}`;

  const handleCopyText = async (text: string, okMsg: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ body: okMsg, type: "info" });
    } catch {
      toast({ body: "复制失败，请手动选中复制", type: "error" });
    }
  };

  const handleManualDeviceCodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeDeviceUserCode(manualDeviceCode);
    if (!normalized) {
      toast({ body: "请输入 8 位设备验证码（如 XXXX-XXXX）", type: "error" });
      return;
    }
    setManualDeviceCode("");
    setDevicesDialogOpen(false);
    void openDeviceApproval(normalized);
  };

  const handleDeviceDecision = async (action: "approve" | "deny") => {
    const code = deviceApprovalInfo?.userCode || deviceApprovalCode;
    if (!code || deviceApprovalSubmitting) return;
    setDeviceApprovalSubmitting(action);
    setDeviceApprovalError(null);
    try {
      const payload: {
        user_code: string;
        action: "approve" | "deny";
        client_name?: string;
      } = {
        user_code: code,
        action,
      };
      if (deviceApprovalInfo?.clientName) {
        payload.client_name = deviceApprovalInfo.clientName;
      }
      const res = await fetch("/api/auth/device/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) {
        setDeviceApprovalOpen(false);
        setCurrentUser(null);
        return;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "处理设备登录请求失败");
      }
      const data: DeviceApproveResponse = await res.json();
      const finalStatus =
        data.status || (action === "approve" ? "approved" : "denied");
      setDeviceApprovalResult(finalStatus);
      toast({
        body:
          finalStatus === "approved"
            ? "已批准设备登录，终端将自动完成连接"
            : "已拒绝该设备登录请求",
        type: "info",
      });
      if (devicesDialogOpen) {
        void loadDeviceTokens();
      }
    } catch (err: any) {
      setDeviceApprovalError(err.message || "处理设备登录请求失败");
    } finally {
      setDeviceApprovalSubmitting(null);
    }
  };

  const handleCreateCiToken = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (creatingCiToken) return;
    const name = ciTokenName.trim() || "CI (HTML_PREVIEW_TOKEN)";
    setCreatingCiToken(true);
    setTokensError(null);
    try {
      const res = await fetch("/api/auth/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.status === 401) {
        setDevicesDialogOpen(false);
        setCurrentUser(null);
        return;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "新建 CI 令牌失败");
      }
      const data: CreateDeviceTokenResponse = await res.json();
      setNewlyCreatedToken({
        token: data.token,
        name: data.item?.name || name,
      });
      setCiTokenName("");
      await loadDeviceTokens();
      toast({ body: "CI 令牌已生成，请立即复制保存", type: "info" });
    } catch (err: any) {
      setTokensError(err.message || "新建 CI 令牌失败");
      toast({ body: err.message || "新建 CI 令牌失败", type: "error" });
    } finally {
      setCreatingCiToken(false);
    }
  };

  const handleRevokeToken = async (item: DeviceTokenItem) => {
    if (revokingTokenId === item.id) return;
    setRevokingTokenId(item.id);
    setTokensError(null);
    try {
      const res = await fetch(
        `/api/auth/tokens/${encodeURIComponent(item.id)}`,
        { method: "DELETE" }
      );
      if (res.status === 401) {
        setDevicesDialogOpen(false);
        setCurrentUser(null);
        return;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "吊销令牌失败");
      }
      setDeviceTokens((prev) => prev.filter((t) => t.id !== item.id));
      toast({ body: `已吊销令牌「${item.name}」`, type: "info" });
    } catch (err: any) {
      toast({ body: err.message || "吊销令牌失败", type: "error" });
    } finally {
      setRevokingTokenId((prev) => (prev === item.id ? null : prev));
    }
  };

  const renderArchiveRow = (item: ArchiveItem) => {
    const isSelected = item.id === selectedId;
    const latestVer = item.versions.at(-1)?.version || 1;
    const isDragOverRow = dragOverArchiveId === item.id;

    return (
      <li
        key={item.id}
        className={`hp-file-row${isSelected ? " is-selected" : ""}${
          isDragOverRow ? " is-dragover" : ""
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOverArchiveId(item.id);
        }}
        onDragLeave={() => {
          setDragOverArchiveId((prev) => (prev === item.id ? null : prev));
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOverArchiveId(null);
          const draggedId = e.dataTransfer.getData("text/plain");
          handleDropOnArchive(draggedId, item);
        }}
      >
        <button
          type="button"
          className={`hp-file-btn${isSelected ? " is-selected" : ""}`}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", item.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => {
            setDragOverArchiveId(null);
            setDragOverFolder(null);
          }}
          onClick={() => {
            setSelectedId(item.id);
            setSelectedVersion(null);
            if (window.matchMedia("(max-width: 680px)").matches) {
              setIsSidebarCollapsed(true);
            }
          }}
          title={`${item.title} (v${latestVer})${item.shared ? " · 已公开" : ""}`}
        >
          <FileCodeSvgIcon />
          <span className="hp-file-label">{item.title}</span>
          {item.shared && (
            <span className="hp-share-pill" title="已公开">
              公开
            </span>
          )}
          <span className="hp-file-ver">v{latestVer}</span>
        </button>

        <div className="hp-file-actions">
          <DropdownMenu
            placement="below"
            alignment="end"
            renderTrigger={(triggerProps) => (
              <button
                type="button"
                className="hp-icon-trigger"
                aria-label={`操作：${item.title}`}
                title="更多操作"
                {...triggerProps}
              >
                <MoreHorizontalIcon />
              </button>
            )}
          >
            <DropdownMenuItem
              label="移动到任务…"
              onClick={() => openEditorModal("move", item)}
            />
            <DropdownMenuItem
              label="重命名标题…"
              onClick={() => openEditorModal("rename", item)}
            />
            <DropdownMenuDivider />
            <DropdownMenuItem
              label="删除 HTML…"
              variant="destructive"
              onClick={() => setDeleteTarget(item)}
            />
          </DropdownMenu>
        </div>
      </li>
    );
  };

  const breadcrumbText = selectedArchive
    ? selectedArchive.folder === "uncategorized"
      ? "未分类"
      : selectedArchive.folder.replace("/", " / ")
    : "";

  const isSharingSelected = Boolean(
    selectedArchive && sharingId === selectedArchive.id
  );

  return (
    <div
      className={`hp-app${isSidebarCollapsed ? " is-collapsed" : ""}${
        isFullscreen ? " is-fullscreen" : ""
      }`}
      id="workspace-view"
    >
      <aside
        className="hp-sidebar"
        id="sidebar"
        aria-label="项目与 HTML 导航"
        style={{ width: `${sidebarWidth}px`, minWidth: `${sidebarWidth}px` }}
      >
        <div className="hp-brand-bar">
          <span className="hp-brand-code" aria-hidden="true">
            &lt;/&gt;
          </span>
          <strong className="hp-brand-title">html-preview</strong>
          <IconButton
            size="sm"
            variant="ghost"
            label="收起侧栏 (Ctrl+B)"
            tooltip="收起侧栏 (Ctrl+B)"
            icon={<PanelLeftIcon />}
            onClick={toggleSidebar}
          />
        </div>

        <div className="hp-sidebar-section">
          <TextInput
            type="search"
            size="sm"
            label="搜索 HTML"
            isLabelHidden
            placeholder="搜索项目、任务或标题…"
            startIcon={<SearchSvgIcon />}
            value={searchQuery}
            onChange={(val) => setSearchQuery(val)}
            hasClear
            width="100%"
          />
        </div>

        <nav className="hp-tree" id="tree" aria-label="项目与 HTML">
          {projectTree.map((proj) => {
            const projKey = `p:${proj.name}`;
            const isProjOpen =
              Boolean(normalizedQuery) || !collapsedFolders.has(projKey);

            return (
              <div key={projKey} className="hp-project-group">
                <div
                  className="hp-tree-summary hp-project-summary"
                  data-open={isProjOpen}
                  onClick={() => toggleFolder(projKey)}
                >
                  <ChevronRightIcon />
                  <FolderSvgIcon />
                  <span className="hp-tree-label" title={proj.name}>
                    {proj.name}
                  </span>
                </div>
                {isProjOpen && (
                  <div className="hp-project-children">
                    {proj.tasks.map((task) => {
                      const folderPath = `${proj.name}/${task.name}`;
                      const taskKey = `t:${folderPath}`;
                      const taskOpen =
                        Boolean(normalizedQuery) || !collapsedFolders.has(taskKey);

                      return (
                        <div key={taskKey} className="hp-task-group">
                          <div
                            className={`hp-tree-summary hp-task-summary${
                              dragOverFolder === folderPath ? " is-dragover" : ""
                            }`}
                            data-open={taskOpen}
                            onClick={() => toggleFolder(taskKey)}
                            onDragOver={(e) => {
                              e.preventDefault();
                              setDragOverFolder(folderPath);
                            }}
                            onDragLeave={() => setDragOverFolder(null)}
                            onDrop={(e) => {
                              e.preventDefault();
                              setDragOverFolder(null);
                              const id = e.dataTransfer.getData("text/plain");
                              if (id) {
                                patchArchive(
                                  id,
                                  { folder: folderPath },
                                  "已移动到目标任务"
                                );
                              }
                            }}
                          >
                            <ChevronRightIcon />
                            <span className="hp-tree-label" title={task.name}>
                              {task.name}
                            </span>
                          </div>
                          {taskOpen && (
                            <ul className="hp-files-list">
                              {task.files.map((file) => renderArchiveRow(file))}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {uncategorizedArchives.length > 0 && (
            <div className="hp-task-group">
              <div
                className={`hp-tree-summary hp-task-summary${
                  dragOverFolder === "uncategorized" ? " is-dragover" : ""
                }`}
                data-open={!collapsedFolders.has("uncategorized")}
                onClick={() => toggleFolder("uncategorized")}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverFolder("uncategorized");
                }}
                onDragLeave={() => setDragOverFolder(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverFolder(null);
                  const id = e.dataTransfer.getData("text/plain");
                  if (id) {
                    patchArchive(id, { folder: "uncategorized" }, "已移至未分类");
                  }
                }}
              >
                <ChevronRightIcon />
                <span className="hp-tree-label">未分类</span>
              </div>
              {!collapsedFolders.has("uncategorized") && (
                <ul className="hp-files-list">
                  {uncategorizedArchives.map((file) => renderArchiveRow(file))}
                </ul>
              )}
            </div>
          )}

          {projectTree.length === 0 && uncategorizedArchives.length === 0 && (
            <div className="hp-tree-empty">
              <p>{normalizedQuery ? "没有匹配的 HTML" : "暂无已上传的 HTML"}</p>
            </div>
          )}
        </nav>

        <footer className="hp-sidebar-footer">
          <DropdownMenu
            placement="above"
            alignment="start"
            renderTrigger={(triggerProps) => (
              <button
                type="button"
                className="hp-footer-identity hp-account-trigger"
                aria-label="个人账号菜单"
                title="个人账号菜单"
                {...triggerProps}
                id={triggerProps.id || "account-btn"}
              >
                <Avatar
                  src={
                    currentUser.avatarUrl ||
                    `https://github.com/${currentUser.login}.png?size=64`
                  }
                  name={currentUser.login}
                  size="xsm"
                  tooltip={false}
                />
                <span className="hp-user-login">@{currentUser.login}</span>
              </button>
            )}
          >
            <DropdownMenuItem
              icon={<KeySvgIcon />}
              label="设备与 CLI 令牌"
              onClick={openDevicesDialog}
            />
            {pushSupported && (
              <DropdownMenuItem
                icon={<BellSvgIcon active={pushSubscribed} />}
                label={pushSubscribed ? "关闭本机离线推送" : "开启离线推送提醒"}
                isDisabled={pushBusy}
                onClick={() => void handleTogglePush()}
              />
            )}
            <DropdownMenuDivider />
            <DropdownMenuItem
              icon={<LogOutSvgIcon />}
              label="退出登录"
              variant="destructive"
              onClick={handleLogout}
            />
          </DropdownMenu>

          <div className="hp-footer-actions">
            <IconButton
              size="sm"
              variant="ghost"
              label={
                themePref === "light"
                  ? "当前：浅色模式（点击切换深色）"
                  : themePref === "dark"
                  ? "当前：深色模式（点击切换跟随系统）"
                  : "当前：跟随系统（点击切换浅色）"
              }
              tooltip={
                themePref === "light"
                  ? "浅色模式 · 点击切换"
                  : themePref === "dark"
                  ? "深色模式 · 点击切换"
                  : "跟随系统 · 点击切换"
              }
              icon={
                themePref === "light" ? (
                  <SunSvgIcon />
                ) : themePref === "dark" ? (
                  <MoonSvgIcon />
                ) : (
                  <MonitorSvgIcon />
                )
              }
              onClick={cycleTheme}
            />

            <IconButton
              size="sm"
              variant="ghost"
              label="刷新目录"
              tooltip="刷新目录与当前预览"
              icon={<RefreshSvgIcon spinning={loadingCatalog} />}
              onClick={() => {
                void loadCatalog(false);
                setIframeReloadTick((t) => t + 1);
              }}
            />
          </div>
        </footer>
      </aside>

      {!isSidebarCollapsed && (
        <div
          id="sidebar-resizer"
          className={`hp-sidebar-resizer${isResizing ? " is-resizing" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="拖拽调整侧边栏宽度（双击恢复默认宽度）"
          title="拖拽调整宽度 · 双击恢复默认"
          tabIndex={0}
          onPointerDown={startSidebarResize}
          onDoubleClick={resetSidebarWidth}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              const w = Math.max(MIN_SIDEBAR_WIDTH, sidebarWidth - 16);
              setSidebarWidth(w);
              writeStorage("html-preview:sidebar-width", w);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              const w = Math.min(MAX_SIDEBAR_WIDTH, sidebarWidth + 16);
              setSidebarWidth(w);
              writeStorage("html-preview:sidebar-width", w);
            }
          }}
        />
      )}

      <main className="hp-main" id="main">
        <header className="hp-toolbar">
          {isSidebarCollapsed && (
            <IconButton
              size="sm"
              variant="ghost"
              label="展开侧栏 (Ctrl+B)"
              tooltip="展开侧栏 (Ctrl+B)"
              icon={<PanelLeftIcon />}
              onClick={toggleSidebar}
            />
          )}

          <div className="hp-doc-inline-heading">
            {selectedArchive ? (
              <>
                <span className="hp-doc-breadcrumb" title={breadcrumbText}>
                  {breadcrumbText}
                </span>
                <span className="hp-doc-sep" aria-hidden="true">
                  /
                </span>
                <h1 className="hp-doc-title" title={selectedArchive.title}>
                  {selectedArchive.title}
                </h1>
              </>
            ) : (
              <h1 className="hp-doc-title">html-preview</h1>
            )}
          </div>

          {selectedArchive && iframeSrc && (
            <div className="hp-toolbar-actions">
              <select
                id="version-select"
                className="hp-version-select"
                aria-label="选择版本"
                value={activeVersion || 1}
                onChange={(e) => setSelectedVersion(Number(e.target.value))}
              >
                {selectedArchive.versions
                  .slice()
                  .reverse()
                  .map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version}
                      {v.version === latestVersion ? " · 最新" : " · 历史"}
                      {v.note ? ` (${v.note.slice(0, 14)})` : ""}
                    </option>
                  ))}
              </select>

              <div className="hp-share-anchor">
                {!selectedArchive.shared ? (
                  <button
                    ref={shareCreateBtnRef}
                    type="button"
                    className="hp-btn"
                    id="btn-share-create"
                    disabled={isSharingSelected}
                    onClick={() => void handleShareArchive(selectedArchive)}
                  >
                    {isSharingSelected && <RefreshSvgIcon spinning />}
                    <span>{isSharingSelected ? "公开中…" : "公开"}</span>
                  </button>
                ) : (
                  selectedShareUrl && (
                    <button
                      ref={shareManageBtnRef}
                      type="button"
                      className="hp-btn-shared"
                      id="btn-share-manage"
                      aria-haspopup="dialog"
                      aria-expanded={sharePopoverOpen}
                      aria-controls="share-popover"
                      onClick={() => setSharePopoverOpen((open) => !open)}
                    >
                      <span className="hp-status-dot" aria-hidden="true" />
                      <span>已公开</span>
                      <ChevronDownIcon />
                    </button>
                  )
                )}

                {selectedArchive.shared && selectedShareUrl && sharePopoverOpen && (
                  <div
                    ref={sharePopoverRef}
                    className="hp-share-popover"
                    id="share-popover"
                    role="dialog"
                    aria-label="已公开链接"
                  >
                    <div className="hp-share-url-box">
                      <code
                        id="share-url-text"
                        className="hp-share-url-text"
                        title={selectedShareUrl}
                      >
                        {selectedShareUrl}
                      </code>
                    </div>

                    <div className="hp-share-popover-actions">
                      <div className="hp-share-popover-main-actions">
                        <button
                          type="button"
                          className="hp-btn hp-btn-sm hp-btn-primary"
                          id="btn-copy-share"
                          onClick={() => void handleCopyShareUrl(selectedShareUrl, true)}
                        >
                          {copiedShareFeedback ? "已复制" : "复制"}
                        </button>
                        <a
                          className="hp-btn hp-btn-sm"
                          id="btn-open-share"
                          href={selectedShareUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          打开
                        </a>
                      </div>

                      <button
                        type="button"
                        className="hp-btn-danger-ghost"
                        id="btn-unshare"
                        disabled={isSharingSelected}
                        onClick={() => void handleUnshareArchive(selectedArchive)}
                      >
                        {isSharingSelected ? "取消中…" : "取消公开"}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <button
                type="button"
                id="btn-interact-toggle"
                className={`hp-btn hp-btn-interact${
                  isInteractOpen ? " is-active" : ""
                }`}
                aria-pressed={isInteractOpen}
                aria-controls="interact-drawer"
                title={`${
                  isInteractOpen ? "收起" : "打开"
                }批注 (${interactShortcutLabel})`}
                onClick={toggleInteract}
              >
                <MessageSquareIcon />
                <span className="hp-interact-btn-label">批注</span>
                {(interactBadge.unreadCount > 0 ||
                  interactBadge.workingCount > 0) && (
                  <span
                    className={`hp-interact-badge${
                      interactBadge.unreadCount > 0
                        ? " is-unread"
                        : " is-working"
                    }`}
                  >
                    {interactBadge.unreadCount > 0
                      ? interactBadge.unreadCount
                      : interactBadge.workingCount}
                  </span>
                )}
              </button>
            </div>
          )}
        </header>

        <div className="hp-stage-body">
        <div className="hp-canvas" id="canvas" ref={canvasRef}>
          {selectedArchive && iframeSrc ? (
            <>
              {showDelayedSpinner && !isCurrentIframeReady && (
                <div className="hp-canvas-loading" aria-live="polite">
                  <RefreshSvgIcon spinning />
                  <span>正在加载预览…</span>
                </div>
              )}
              {iframePool.map((entry) => {
                const isTarget = entry.key === iframeKey;
                const isReady = loadedIframeKeys.has(entry.key);
                const isFallbackVisible =
                  !isCurrentIframeReady && entry.key === lastReadyIframeKey;
                const isVisible = (isTarget && isReady) || isFallbackVisible;
                return (
                  <iframe
                    key={entry.key}
                    ref={isTarget ? iframeRef : undefined}
                    id={isTarget ? "preview" : undefined}
                    title={entry.title}
                    src={entry.src}
                    sandbox="allow-scripts"
                    allow="fullscreen"
                    className={`hp-preview-iframe${isVisible ? " is-visible" : " is-hidden"}`}
                    onLoad={() => {
                      setLoadedIframeKeys((prev) => {
                        if (prev.has(entry.key)) return prev;
                        const next = new Set(prev);
                        next.add(entry.key);
                        return next;
                      });
                      setLastReadyIframeKey(entry.key);
                      setShowDelayedSpinner(false);
                    }}
                  />
                );
              })}
            </>
          ) : loadingCatalog && !catalogLoaded && archives.length === 0 ? (
            <div className="hp-canvas-loading" aria-live="polite">
              <RefreshSvgIcon spinning />
              <span>正在加载工作区…</span>
            </div>
          ) : (
            <div className="hp-blank-state">
              <FileCodeSvgIcon />
              <h2>{archives.length === 0 ? "暂无 HTML" : "选择一个 HTML 开始预览"}</h2>
              {archives.length === 0 && (
                <p>运行 html-preview upload 上传页面</p>
              )}
            </div>
          )}
        </div>

        <InteractDrawer
          isOpen={isInteractOpen}
          onOpenChange={setIsInteractOpen}
          archive={selectedArchive}
          activeVersion={activeVersion}
          latestVersion={latestVersion}
          selectionAnchor={selectionAnchor}
          onClearSelection={handleClearSelection}
          onSelectVersion={(ver) => {
            setSelectedVersion(ver === latestVersion ? null : ver);
          }}
          onRefreshCatalog={handleRefreshCatalogSilent}
          wsReconnectTick={wsReconnectTick}
          subscribeRealtimeInteraction={subscribeRealtimeInteraction}
          sendRealtime={sendRealtime}
          highlightedInteractionId={highlightedInteractionId}
          onClearHighlight={handleClearHighlight}
          onBadgeChange={setInteractBadge}
          onReadingOrTypingChange={handleReadingOrTypingChange}
          focusRequestTick={interactFocusTick}
          pushSupported={pushSupported}
          pushSubscribed={pushSubscribed}
          pushBusy={pushBusy}
          onTogglePush={handleTogglePush}
        />
        </div>
      </main>

      <Dialog
        isOpen={deviceApprovalOpen}
        onOpenChange={(open) => {
          if (!open && !deviceApprovalSubmitting) {
            setDeviceApprovalOpen(false);
          }
        }}
        width={460}
        purpose="form"
      >
        <Layout
          header={
            <DialogHeader
              title="批准 CLI 设备登录"
              onOpenChange={(open) => {
                if (!open && !deviceApprovalSubmitting) {
                  setDeviceApprovalOpen(false);
                }
              }}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <Stack gap={3} align="stretch">
                {deviceApprovalLoading ? (
                  <div className="hp-inline-loading" aria-live="polite">
                    <RefreshSvgIcon spinning />
                    <span>正在核验设备验证码…</span>
                  </div>
                ) : deviceApprovalResult === "approved" ? (
                  <div className="hp-success-banner" role="status">
                    <strong>✓ 已批准设备登录</strong>
                    <span>可返回终端继续。</span>
                  </div>
                ) : deviceApprovalResult === "denied" ? (
                  <div className="hp-info-banner" role="status">
                    已拒绝本次 CLI 设备登录请求。
                  </div>
                ) : (
                  <>
                    {deviceApprovalError && (
                      <div className="hp-error-banner" role="alert">
                        {deviceApprovalError}
                      </div>
                    )}

                    {deviceApprovalInfo && (
                      <div className="hp-receipt-box">
                        <div className="hp-device-verify-code-wrap">
                          <span className="hp-device-verify-caption">
                            终端设备验证码
                          </span>
                          <code
                            id="device-verify-user-code"
                            className="hp-device-verify-code"
                          >
                            {deviceApprovalInfo.userCode}
                          </code>
                        </div>

                        <div className="hp-device-meta-list">
                          <div className="hp-device-meta-row">
                            <span>请求设备</span>
                            <strong>{deviceApprovalInfo.clientName}</strong>
                          </div>
                          <div className="hp-device-meta-row">
                            <span>授权账号</span>
                            <strong>@{currentUser.login}</strong>
                          </div>
                          {deviceApprovalInfo.expiresAt && (
                            <div className="hp-device-meta-row">
                              <span>过期时间</span>
                              <span>
                                {formatDateTime(deviceApprovalInfo.expiresAt)}
                              </span>
                            </div>
                          )}
                        </div>

                        {deviceApprovalInfo.status !== "pending" ? (
                          <div className="hp-info-banner" role="status">
                            {deviceApprovalInfo.status === "approved" ||
                            deviceApprovalInfo.status === "consumed"
                              ? "该设备授权码已批准。"
                              : "该设备授权码已拒绝或失效。"}
                          </div>
                        ) : (
                          <p className="hp-receipt-hint">
                            请核对上方 8 位验证码与终端一致。
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </Stack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="hp-dialog-footer">
                {!deviceApprovalLoading &&
                !deviceApprovalResult &&
                deviceApprovalInfo?.status === "pending" ? (
                  <>
                    <Button
                      id="btn-device-deny"
                      variant="secondary"
                      label="拒绝"
                      isDisabled={deviceApprovalSubmitting !== null}
                      isLoading={deviceApprovalSubmitting === "deny"}
                      onClick={() => void handleDeviceDecision("deny")}
                    />
                    <Button
                      id="btn-device-approve"
                      variant="primary"
                      label="批准设备登录"
                      isDisabled={deviceApprovalSubmitting !== null}
                      isLoading={deviceApprovalSubmitting === "approve"}
                      onClick={() => void handleDeviceDecision("approve")}
                    />
                  </>
                ) : (
                  <Button
                    variant="secondary"
                    label="关闭"
                    onClick={() => setDeviceApprovalOpen(false)}
                  />
                )}
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      <Dialog
        isOpen={devicesDialogOpen}
        onOpenChange={handleDevicesDialogOpenChange}
        width={560}
        purpose="info"
      >
        <Layout
          header={
            <DialogHeader
              title="设备与 CLI 令牌"
              onOpenChange={handleDevicesDialogOpenChange}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <Stack gap={3} align="stretch">
                <div className="hp-receipt-box">
                  <div className="hp-receipt-title">
                    <span>CLI 设备登录命令</span>
                  </div>
                  <div className="hp-receipt-code">
                    <code id="cli-config-text" className="hp-receipt-mono">
                      {cliLoginCommand}
                    </code>
                    <div className="hp-receipt-actions">
                      <Button
                        size="sm"
                        variant="primary"
                        label="复制命令"
                        onClick={() =>
                          void handleCopyText(
                            cliLoginCommand,
                            "CLI 登录命令已复制"
                          )
                        }
                      />
                    </div>
                  </div>
                </div>

                <div className="hp-receipt-box">
                  <div className="hp-receipt-title">
                    <span>手动输入设备验证码</span>
                  </div>
                  <form
                    className="hp-inline-form"
                    onSubmit={handleManualDeviceCodeSubmit}
                  >
                    <div className="hp-inline-form-input">
                      <TextInput
                        id="manual-device-code-input"
                        label="8 位设备验证码"
                        isLabelHidden
                        placeholder="XXXX-XXXX"
                        value={manualDeviceCode}
                        onChange={(val) =>
                          setManualDeviceCode(val.toUpperCase().slice(0, 12))
                        }
                        autoComplete="off"
                        hasSpellCheck={false}
                        width="100%"
                      />
                    </div>
                    <Button
                      type="submit"
                      variant="secondary"
                      label="验证设备码"
                      isDisabled={!manualDeviceCode.trim()}
                    />
                  </form>
                </div>

                <div className="hp-receipt-box">
                  <div className="hp-receipt-title">
                    <span>无头环境与 CI 令牌</span>
                  </div>
                  <form className="hp-inline-form" onSubmit={handleCreateCiToken}>
                    <div className="hp-inline-form-input">
                      <TextInput
                        id="ci-token-name-input"
                        label="CI 令牌名称"
                        isLabelHidden
                        placeholder="备注名称（可选，例如 GitHub Actions）"
                        value={ciTokenName}
                        onChange={setCiTokenName}
                        autoComplete="off"
                        width="100%"
                      />
                    </div>
                    <Button
                      id="btn-create-ci-token"
                      type="submit"
                      variant="secondary"
                      label="新建 CI 令牌 (HTML_PREVIEW_TOKEN)"
                      isLoading={creatingCiToken}
                    />
                  </form>

                  {newlyCreatedToken && (
                    <div
                      className="hp-token-once-banner"
                      id="one-time-token-banner"
                      role="region"
                      aria-label="一次性新令牌"
                    >
                      <div className="hp-token-once-head">
                        <strong>
                          新令牌「{newlyCreatedToken.name}」
                        </strong>
                        <span>仅显示一次</span>
                      </div>
                      <div className="hp-receipt-code">
                        <code id="new-ci-token-text" className="hp-receipt-mono">
                          {newlyCreatedToken.token}
                        </code>
                        <div className="hp-receipt-actions">
                          <Button
                            size="sm"
                            variant="primary"
                            label="复制令牌"
                            onClick={() =>
                              void handleCopyText(
                                newlyCreatedToken.token,
                                "HTML_PREVIEW_TOKEN 已复制"
                              )
                            }
                          />
                          <Button
                            size="sm"
                            variant="secondary"
                            label="复制 ENV"
                            onClick={() =>
                              void handleCopyText(
                                `export HTML_PREVIEW_TOKEN=${newlyCreatedToken.token}`,
                                "环境变量导出命令已复制"
                              )
                            }
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="hp-receipt-box">
                  <div className="hp-receipt-title">
                    <span>已授权设备与活跃令牌 ({deviceTokens.length})</span>
                    <button
                      type="button"
                      className="hp-icon-trigger"
                      title="刷新令牌列表"
                      aria-label="刷新令牌列表"
                      onClick={() => void loadDeviceTokens()}
                    >
                      <RefreshSvgIcon spinning={loadingTokens} />
                    </button>
                  </div>

                  {tokensError && (
                    <div className="hp-error-banner" role="alert">
                      {tokensError}
                    </div>
                  )}

                  {loadingTokens && deviceTokens.length === 0 ? (
                    <div className="hp-inline-loading">
                      <RefreshSvgIcon spinning />
                      <span>正在加载活跃令牌…</span>
                    </div>
                  ) : deviceTokens.length === 0 ? (
                    <p className="hp-token-empty">
                      暂无已授权的 CLI 设备或 CI 令牌
                    </p>
                  ) : (
                    <ul className="hp-token-list" id="device-tokens-list">
                      {deviceTokens.map((token) => (
                        <li key={token.id} className="hp-token-item">
                          <div className="hp-token-info">
                            <div className="hp-token-head">
                              <strong className="hp-token-name">
                                {token.name}
                              </strong>
                              <code className="hp-token-prefix">
                                {token.tokenPrefix}
                              </code>
                            </div>
                            <div className="hp-token-meta">
                              <span>
                                创建于 {formatDateTime(token.createdAt)}
                              </span>
                              <span>·</span>
                              <span>
                                {token.lastUsedAt
                                  ? `最近使用 ${formatDateTime(token.lastUsedAt)}`
                                  : "尚未使用"}
                              </span>
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="destructive"
                            label="吊销"
                            isLoading={revokingTokenId === token.id}
                            isDisabled={
                              revokingTokenId !== null &&
                              revokingTokenId !== token.id
                            }
                            onClick={() => void handleRevokeToken(token)}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Stack>
            </LayoutContent>
          }
        />
      </Dialog>

      <Dialog
        isOpen={editorModal !== null}
        onOpenChange={(open) => !open && setEditorModal(null)}
        width={420}
        purpose="form"
      >
        <Layout
          header={
            <DialogHeader
              title={
                editorModal?.mode === "move"
                  ? "移动 HTML 到任务"
                  : "重命名 HTML 标题"
              }
              onOpenChange={(open) => !open && setEditorModal(null)}
              hasDivider
            />
          }
          content={
            <LayoutContent>
              <form id="hp-editor-form" onSubmit={handleSaveEditor}>
                <Stack gap={3} align="stretch">
                  {editorModal?.mode === "move" ? (
                    <>
                      <TextInput
                        label="所属项目"
                        placeholder="输入或选择目标项目名称"
                        value={editorProject}
                        onChange={setEditorProject}
                        isRequired
                        width="100%"
                      />
                      {allExistingProjects.length > 0 && (
                        <div className="hp-chip-suggestions">
                          {allExistingProjects.map((p) => (
                            <button
                              key={p.name}
                              type="button"
                              className="hp-chip-btn"
                              onClick={() => {
                                setEditorProject(p.name);
                                if (p.tasks[0]) setEditorMoveTask(p.tasks[0]);
                              }}
                            >
                              {p.name}
                            </button>
                          ))}
                        </div>
                      )}
                      <TextInput
                        label="目标任务"
                        placeholder="输入或选择目标任务名称"
                        value={editorMoveTask}
                        onChange={setEditorMoveTask}
                        isRequired
                        width="100%"
                      />
                    </>
                  ) : (
                    <TextInput
                      label="HTML 标题"
                      placeholder="输入新的 HTML 显示标题"
                      value={editorName}
                      onChange={setEditorName}
                      hasAutoFocus
                      isRequired
                      width="100%"
                    />
                  )}
                </Stack>
              </form>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <div className="hp-dialog-footer">
                <Button
                  variant="secondary"
                  label="取消"
                  onClick={() => setEditorModal(null)}
                />
                <Button
                  type="submit"
                  form="hp-editor-form"
                  variant="primary"
                  label="保存"
                  isLoading={editorSaving}
                />
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>

      <AlertDialog
        isOpen={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`删除「${deleteTarget?.title || ""}」？`}
        description={`共 ${
          deleteTarget?.versions.length || 1
        } 个版本将永久删除${
          deleteTarget?.shared ? "，公开链接同步失效" : ""
        }，不可撤销。`}
        cancelLabel="取消"
        actionLabel="删除"
        actionVariant="destructive"
        isActionLoading={deleting}
        onAction={handleConfirmDelete}
      />
    </div>
  );
}

export function App() {
  const [themePref, setThemePref] = useState<ThemePreference>(() =>
    readStorage<ThemePreference>("html-preview:theme", "system")
  );

  const handleThemeChange = (mode: ThemePreference) => {
    setThemePref(mode);
    writeStorage("html-preview:theme", mode);
  };

  return (
    <Theme theme={neutralTheme} mode={themePref}>
      <LayerProvider>
        <WorkspaceInner themePref={themePref} onThemeChange={handleThemeChange} />
      </LayerProvider>
    </Theme>
  );
}
