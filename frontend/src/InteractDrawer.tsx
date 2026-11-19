import { AcpTranscript } from "./AcpTranscript";
import { useAcpSession } from "./useAcpSession";
import type { AcpClientFrame, AcpServerFrame } from "../../src/acp-types";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@astryxdesign/core/Toast";
import { RefreshSvgIcon } from "./icons";
import type {
  ArchiveItem,
  DocumentInteractionsResponse,
  HostPresenceInfo,
  InteractionRecord,
  InteractionStatus,
  PushSubscriptionItem,
  RealtimeDrawerMessage,
  SelectionAnchor,
  SessionBinding,
} from "./types";

export type MobileDetent = "collapsed" | "half" | "full";

export interface InteractBadgeCounts {
  workingCount: number;
  unreadCount: number;
}

export interface InteractDrawerProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  archive: ArchiveItem | null;
  activeVersion: number | null;
  latestVersion: number;
  selectionAnchor: SelectionAnchor | null;
  onClearSelection: () => void;
  onSelectVersion: (version: number) => void;
  onRefreshCatalog: () => void;
  wsReconnectTick: number;
  subscribeRealtimeInteraction: (
    fn: ((msg: RealtimeDrawerMessage) => void) | null
  ) => void;
  sendRealtime: (frame: AcpClientFrame) => boolean;
  highlightedInteractionId: string | null;
  onClearHighlight: () => void;
  onBadgeChange: (counts: InteractBadgeCounts) => void;
  onReadingOrTypingChange?: (active: boolean) => void;
  focusRequestTick?: number;
  pushSupported?: boolean;
  pushSubscribed?: boolean;
  pushBusy?: boolean;
  onTogglePush?: () => void;
}

export const MessageSquareIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

export const BellSvgIcon = ({ active = false }: { active?: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill={active ? "currentColor" : "none"}
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);

const CloseSvgIcon = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

const MicSvgIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" x2="12" y1="19" y2="22" />
  </svg>
);

export function formatAdapterLabel(adapterId?: string | null): string {
  const cleaned = (adapterId || "").trim();
  if (!cleaned || cleaned === "auto") return "自动连接";
  return cleaned;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(
    navigator.platform || navigator.userAgent || ""
  );
}

function isWorkingStatus(status: InteractionStatus): boolean {
  return (
    status === "pending" ||
    status === "leased" ||
    status === "dispatched" ||
    status === "working"
  );
}

function formatShortTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function inspectBrowserPushStatus(): Promise<{
  supported: boolean;
  subscribed: boolean;
  endpoint: string | null;
  vapidPublicKey: string | null;
}> {
  if (
    typeof window === "undefined" ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return {
      supported: false,
      subscribed: false,
      endpoint: null,
      vapidPublicKey: null,
    };
  }
  try {
    const reg =
      (await navigator.serviceWorker.getRegistration("/sw.js").catch(() => undefined)) ||
      (await navigator.serviceWorker.getRegistration().catch(() => undefined));
    const sub = await reg?.pushManager?.getSubscription().catch(() => null);
    const browserEndpoint = sub?.endpoint || null;

    const res = await fetch("/api/push/subscriptions");
    if (!res.ok) {
      return {
        supported: true,
        subscribed: false,
        endpoint: browserEndpoint,
        vapidPublicKey: null,
      };
    }
    const raw = await res.json();
    const list: PushSubscriptionItem[] = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.subscriptions)
      ? raw.subscriptions
      : [];
    const metaKey =
      typeof document !== "undefined"
        ? document
            .querySelector('meta[name="hp-vapid-public-key"]')
            ?.getAttribute("content") || null
        : null;
    const key =
      typeof raw?.vapidPublicKey === "string" && raw.vapidPublicKey.trim()
        ? raw.vapidPublicKey.trim()
        : metaKey;
    const subscribed = Boolean(
      browserEndpoint && list.some((s) => s.endpoint === browserEndpoint)
    );
    return {
      supported: true,
      subscribed,
      endpoint: browserEndpoint,
      vapidPublicKey: key,
    };
  } catch {
    return {
      supported: true,
      subscribed: false,
      endpoint: null,
      vapidPublicKey: null,
    };
  }
}

export async function toggleBrowserPushSubscription(): Promise<{
  subscribed: boolean;
  message: string;
}> {
  const status = await inspectBrowserPushStatus();
  if (!status.supported) {
    throw new Error("当前浏览器不支持 Web Push（iOS 请先添加到主屏幕）");
  }
  if (status.subscribed && status.endpoint) {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (sub && sub.endpoint === status.endpoint) {
      await sub.unsubscribe().catch(() => {});
    }
    const res = await fetch(
      `/api/push/subscriptions?endpoint=${encodeURIComponent(status.endpoint)}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: status.endpoint }),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "关闭离线推送失败");
    }
    return { subscribed: false, message: "已关闭本机离线推送" };
  }

  if (!status.vapidPublicKey) {
    throw new Error("服务端尚未配置 VAPID 公钥，页面打开期间仍提供实时提醒");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("未授予系统通知权限");
  }
  const reg =
    (await navigator.serviceWorker.getRegistration("/sw.js")) ||
    (await navigator.serviceWorker.register("/sw.js"));
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ||
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(status.vapidPublicKey),
    }));
  const jsonSub = sub.toJSON();
  if (!jsonSub.endpoint || !jsonSub.keys?.p256dh || !jsonSub.keys?.auth) {
    throw new Error("浏览器返回的推送订阅信息不完整");
  }
  const res = await fetch("/api/push/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: jsonSub.endpoint,
      keys: {
        p256dh: jsonSub.keys.p256dh,
        auth: jsonSub.keys.auth,
      },
      userAgent: navigator.userAgent,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "开启离线推送失败");
  }
  return {
    subscribed: true,
    message: "已开启离线推送",
  };
}

function renderStructuredReply(text: string): React.ReactNode {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("```") && part.endsWith("```")) {
      const inner = part.slice(3, -3).replace(/^[a-zA-Z0-9_-]+\n/, "");
      return (
        <pre key={idx} className="hp-int-code-block">
          <code>{inner}</code>
        </pre>
      );
    }
    if (!part) return null;
    return (
      <div key={idx} className="hp-int-reply-paragraph">
        {part}
      </div>
    );
  });
}

function getSpeechRecognitionCtor(): (new () => any) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => any;
    webkitSpeechRecognition?: new () => any;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

interface InteractionThread {
  threadId: string;
  turns: InteractionRecord[];
  firstTurn: InteractionRecord;
  latestTurn: InteractionRecord;
}

export function InteractDrawer({
  isOpen,
  onOpenChange,
  archive,
  activeVersion,
  latestVersion,
  selectionAnchor,
  onClearSelection,
  onSelectVersion,
  onRefreshCatalog,
  wsReconnectTick,
  subscribeRealtimeInteraction,
  sendRealtime,
  highlightedInteractionId,
  onClearHighlight,
  onBadgeChange,
  onReadingOrTypingChange,
  focusRequestTick = 0,
  pushSupported = false,
  pushSubscribed = false,
  pushBusy = false,
  onTogglePush,
}: InteractDrawerProps) {
  const toast = useToast();
  const isMac = useMemo(() => isMacPlatform(), []);
  const toggleShortcutLabel = isMac ? "⌘I" : "Ctrl+I";
  const sendShortcutLabel = isMac ? "⌘Enter" : "Ctrl+Enter";

  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 768px)").matches
      : false
  );
  const [mobileDetent, setMobileDetent] = useState<MobileDetent>("half");

  const [bindings, setBindings] = useState<SessionBinding[]>([]);
  const [interactions, setInteractions] = useState<InteractionRecord[]>([]);
  const [onlineHosts, setOnlineHosts] = useState<HostPresenceInfo[]>([]);
  const [presenceLoaded, setPresenceLoaded] = useState(false);
  const [pushPromptDismissed, setPushPromptDismissed] = useState(false);
  const [loadingDocState, setLoadingDocState] = useState(false);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => new Set());

  const [intent, setIntent] = useState<"change" | "question">("change");
  const [prompt, setPrompt] = useState("");
  const [replyTarget, setReplyTarget] = useState<{
    threadId: string;
    nextTurn: number;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [actingInteractionId, setActingInteractionId] = useState<string | null>(
    null
  );

  const [isListening, setIsListening] = useState(false);
  const speechSupported = useMemo(() => Boolean(getSpeechRecognitionCtor()), []);
  const recognitionRef = useRef<any>(null);

  const latestSeqRef = useRef<number>(0);
  const activeDocIdRef = useRef<string | null>(null);
  const pendingRequestIdRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const threadListRef = useRef<HTMLDivElement | null>(null);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  const mobileDetentRef = useRef(mobileDetent);
  mobileDetentRef.current = mobileDetent;

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia("(max-width: 768px)");
    const onChange = () => setIsMobile(mql.matches);
    setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const active = Boolean(isOpen && prompt.trim().length > 0);
    onReadingOrTypingChange?.(active);
  }, [isOpen, prompt, onReadingOrTypingChange]);

  const isActivelyViewingCards =
    isOpen && (!isMobile || mobileDetent !== "collapsed");

  useEffect(() => {
    if (isActivelyViewingCards && unreadIds.size > 0) {
      setUnreadIds(new Set());
    }
  }, [isActivelyViewingCards, unreadIds.size]);

  useEffect(() => {
    if (highlightedInteractionId && isOpen && isMobile && mobileDetent === "collapsed") {
      setMobileDetent("half");
    }
  }, [highlightedInteractionId, isOpen, isMobile, mobileDetent]);

  // Focus composer textarea whenever opened via shortcut or selection pill
  useEffect(() => {
    if (!isOpen || focusRequestTick <= 0) return;
    if (isMobile && mobileDetent === "collapsed") {
      setMobileDetent("half");
    }
    const timer = setTimeout(() => {
      try {
        window.focus();
      } catch {}
      textareaRef.current?.focus();
    }, 35);
    return () => clearTimeout(timer);
  }, [focusRequestTick, isOpen, isMobile, mobileDetent]);

  const activeBinding = useMemo<SessionBinding | null>(() => {
    if (bindings.length === 0) return null;
    const targetVer = activeVersion || latestVersion;
    const exactOrPrior = bindings.find((b) => b.version <= targetVer);
    return exactOrPrior || bindings[0] || null;
  }, [bindings, activeVersion, latestVersion]);

  const acp = useAcpSession({ open: isOpen && (!isMobile || mobileDetent !== "collapsed"), documentId: archive?.id,
    version: activeVersion || latestVersion, intent, binding: activeBinding, hosts: onlineHosts,
    reconnect: wsReconnectTick, send: sendRealtime });

  const upsertInteractionList = useCallback(
    (prev: InteractionRecord[], incoming: InteractionRecord[]): InteractionRecord[] => {
      if (incoming.length === 0) return prev;
      const map = new Map<string, InteractionRecord>();
      for (const item of prev) map.set(item.id, item);
      for (const item of incoming) map.set(item.id, item);
      return Array.from(map.values()).sort((a, b) => {
        const byTime = (a.createdAt || "").localeCompare(b.createdAt || "");
        if (byTime !== 0) return byTime;
        return a.turnIndex - b.turnIndex;
      });
    },
    []
  );

  const fetchDocumentInteractions = useCallback(
    async (docId: string, afterSeq: number, isInitial = false) => {
      if (isInitial) setLoadingDocState(true);
      try {
        const res = await fetch(
          `/api/archives/${encodeURIComponent(docId)}/interactions?afterSeq=${Math.max(
            0,
            Math.floor(afterSeq)
          )}`
        );
        if (!res.ok) return;
        const data: DocumentInteractionsResponse = await res.json();
        if (activeDocIdRef.current !== docId) return;

        if (Array.isArray(data.bindings)) {
          setBindings(data.bindings);
        }
        const incomingHosts = Array.isArray(data.onlineHosts)
          ? data.onlineHosts
          : Array.isArray(data.hostPresence?.onlineHosts)
          ? data.hostPresence.onlineHosts
          : null;
        if (incomingHosts) {
          setOnlineHosts(incomingHosts);
          setPresenceLoaded(true);
        }
        if (Array.isArray(data.interactions)) {
          setInteractions((prev) =>
            isInitial ? data.interactions : upsertInteractionList(prev, data.interactions)
          );
        }

        if (!isInitial && Array.isArray(data.events) && data.events.length > 0) {
          const prevSeq = latestSeqRef.current;
          const freshEvents = data.events.filter((ev) => ev.seq > prevSeq);
          const hasVersionUpdate = freshEvents.some(
            (ev) => ev.kind === "version_linked" || Boolean(ev.resultVersion)
          );
          if (hasVersionUpdate) {
            onRefreshCatalog();
          }
          const drawerHidden =
            !isOpenRef.current ||
            (isMobileRef.current && mobileDetentRef.current === "collapsed");
          if (drawerHidden) {
            const actionable = freshEvents.filter(
              (ev) =>
                ev.kind === "replied" ||
                ev.kind === "version_linked" ||
                ev.kind === "needs_attention" ||
                ev.kind === "failed"
            );
            if (actionable.length > 0) {
              setUnreadIds((prev) => {
                const next = new Set(prev);
                for (const ev of actionable) next.add(ev.interactionId);
                return next;
              });
            }
          }
        }

        if (typeof data.latestSeq === "number") {
          latestSeqRef.current = Math.max(latestSeqRef.current, data.latestSeq);
        }
      } catch {
        // Silent resilience on transient network drop
      } finally {
        if (isInitial && activeDocIdRef.current === docId) {
          setLoadingDocState(false);
        }
      }
    },
    [onRefreshCatalog, upsertInteractionList]
  );

  useEffect(() => {
    const docId = archive?.id || null;
    activeDocIdRef.current = docId;
    latestSeqRef.current = 0;
    pendingRequestIdRef.current = null;
    setBindings([]);
    setInteractions([]);
    setUnreadIds(new Set());
    setReplyTarget(null);
    setSendError(null);

    if (!docId) return;
    void fetchDocumentInteractions(docId, 0, true);
  }, [archive?.id, fetchDocumentInteractions]);

  useEffect(() => {
    const handler = (msg: RealtimeDrawerMessage) => {
      if (!msg) return;
      if (msg.type.startsWith("acp_")) { acp.receive(msg as AcpServerFrame); return; }
      if (msg.type === "host_presence") {
        if (Array.isArray(msg.hosts)) {
          setOnlineHosts(msg.hosts);
          setPresenceLoaded(true);
        }
        return;
      }
      if (msg.type !== "interaction") return;
      if (msg.documentId !== activeDocIdRef.current) return;

      if (typeof msg.seq === "number") {
        latestSeqRef.current = Math.max(latestSeqRef.current, msg.seq);
      }
      if (msg.interaction) {
        setInteractions((prev) => upsertInteractionList(prev, [msg.interaction]));
      }
      const drawerHidden =
        !isOpenRef.current ||
        (isMobileRef.current && mobileDetentRef.current === "collapsed");
      if (
        drawerHidden &&
        (msg.kind === "replied" ||
          msg.kind === "version_linked" ||
          msg.kind === "needs_attention" ||
          msg.kind === "failed")
      ) {
        setUnreadIds((prev) => {
          const next = new Set(prev);
          next.add(msg.interaction.id);
          return next;
        });
      }
    };

    subscribeRealtimeInteraction(handler);
    return () => subscribeRealtimeInteraction(null);
  }, [subscribeRealtimeInteraction, upsertInteractionList, acp.receive]);

  useEffect(() => {
    const docId = archive?.id;
    if (!docId) return;

    const catchUp = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (!activeDocIdRef.current) return;
      void fetchDocumentInteractions(
        activeDocIdRef.current,
        latestSeqRef.current,
        false
      );
    };

    document.addEventListener("visibilitychange", catchUp);
    window.addEventListener("focus", catchUp);
    return () => {
      document.removeEventListener("visibilitychange", catchUp);
      window.removeEventListener("focus", catchUp);
    };
  }, [archive?.id, fetchDocumentInteractions]);

  useEffect(() => {
    if (wsReconnectTick <= 0 || !archive?.id) return;
    void fetchDocumentInteractions(archive.id, latestSeqRef.current, false);
  }, [wsReconnectTick, archive?.id, fetchDocumentInteractions]);

  const onlineHostIdSet = useMemo(
    () => new Set(onlineHosts.map((h) => h.hostId)),
    [onlineHosts]
  );

  const resolveTurnHost = useCallback(
    (turn: InteractionRecord) => {
      const hostId = turn.targetHostId || activeBinding?.hostId || null;
      const onlineMatch = hostId
        ? onlineHosts.find((h) => h.hostId === hostId)
        : null;
      const hostName =
        turn.targetHostName ||
        onlineMatch?.hostName ||
        (activeBinding?.hostId === hostId ? activeBinding?.hostName : null) ||
        hostId ||
        null;
      const isHostOnline = hostId
        ? onlineHostIdSet.has(hostId)
        : onlineHosts.length > 0;
      return { hostId, hostName, isHostOnline };
    },
    [activeBinding, onlineHosts, onlineHostIdSet]
  );

  const queueSummary = useMemo(() => {
    let workingCount = 0;
    let sleepingCount = 0;
    let offlinePendingCount = 0;
    let sleepingHostLabel: string | null = null;
    for (const item of interactions) {
      if (!isWorkingStatus(item.status)) continue;
      workingCount += 1;
      if (item.status === "pending" && presenceLoaded) {
        const { hostId, hostName, isHostOnline } = resolveTurnHost(item);
        if (hostId && !isHostOnline) {
          sleepingCount += 1;
          if (!sleepingHostLabel && hostName) sleepingHostLabel = hostName;
        } else if (!hostId && onlineHosts.length === 0) {
          offlinePendingCount += 1;
        }
      }
    }
    const activeRunningCount = Math.max(
      0,
      workingCount - sleepingCount - offlinePendingCount
    );
    return {
      workingCount,
      sleepingCount,
      offlinePendingCount,
      activeRunningCount,
      sleepingHostLabel,
    };
  }, [interactions, presenceLoaded, resolveTurnHost, onlineHosts.length]);

  const workingCount = queueSummary.workingCount;

  useEffect(() => {
    onBadgeChange({
      workingCount,
      unreadCount: unreadIds.size,
    });
  }, [workingCount, unreadIds.size, onBadgeChange]);

  useEffect(() => {
    if (!highlightedInteractionId || !isActivelyViewingCards) return;
    const el = document.getElementById(
      `interaction-card-${highlightedInteractionId}`
    );
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = setTimeout(() => {
      onClearHighlight();
    }, 4200);
    return () => clearTimeout(timer);
  }, [
    highlightedInteractionId,
    isActivelyViewingCards,
    interactions.length,
    onClearHighlight,
  ]);

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {}
    };
  }, []);

  const toggleSpeechInput = () => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;

    if (isListening && recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
      setIsListening(false);
      return;
    }

    try {
      const recognition = new Ctor();
      recognition.lang = navigator.language || "zh-CN";
      recognition.interimResults = false;
      recognition.continuous = false;

      recognition.onresult = (event: any) => {
        let transcript = "";
        for (let i = event.resultIndex || 0; i < event.results.length; i++) {
          if (event.results[i]?.isFinal) {
            transcript += event.results[i][0]?.transcript || "";
          }
        }
        const cleaned = transcript.trim();
        if (cleaned) {
          setPrompt((prev) => (prev ? `${prev} ${cleaned}` : cleaned));
          textareaRef.current?.focus();
        }
      };
      recognition.onerror = () => {
        setIsListening(false);
      };
      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
      setIsListening(true);
      recognition.start();
    } catch {
      setIsListening(false);
      toast({ body: "当前浏览器无法启动语音听写", type: "error" });
    }
  };

  const submitInteraction = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!archive || sending) return;
    const trimmed = prompt.trim();
    if (!trimmed) return;

    if (intent === "question") {
      if (acp.state?.status !== "ready" || !acp.sendPrompt(trimmed, selectionAnchor)) { setSendError("只读会话尚未连接，请稍后重试"); return; }
      setPrompt(""); setReplyTarget(null); setSendError(null); onClearSelection(); return;
    }
    if (!pendingRequestIdRef.current) {
      pendingRequestIdRef.current = crypto.randomUUID();
    }
    const requestId = pendingRequestIdRef.current;

    setSending(true);
    setSendError(null);
    try {
      const res = await fetch(
        `/api/archives/${encodeURIComponent(archive.id)}/interactions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId,
            intent: "change",
            threadId: replyTarget?.threadId || undefined,
            baseVersion: activeVersion || latestVersion,
            anchor: selectionAnchor || undefined,
            prompt: trimmed,
          }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `发送失败 (${res.status})`);
      }
      const data = await res.json();
      const created: InteractionRecord = data.interaction ?? data;
      if (Array.isArray(data.hostPresence?.onlineHosts)) {
        setOnlineHosts(data.hostPresence.onlineHosts);
        setPresenceLoaded(true);
      }
      if (data.event?.seq) {
        latestSeqRef.current = Math.max(latestSeqRef.current, data.event.seq);
      }
      setInteractions((prev) => upsertInteractionList(prev, [created]));
      pendingRequestIdRef.current = null;
      setPrompt("");
      setReplyTarget(null);
      setSendError(null);
      onClearSelection();

      requestAnimationFrame(() => {
        if (threadListRef.current) {
          threadListRef.current.scrollTo({
            top: threadListRef.current.scrollHeight,
            behavior: "smooth",
          });
        }
      });
    } catch (err: any) {
      setSendError(
        err?.message || "网络波动导致发送未确认，点击「重试」将幂等重发"
      );
    } finally {
      setSending(false);
    }
  };

  const handleInteractionAction = async (
    interaction: InteractionRecord,
    action: "resolve" | "retry"
  ) => {
    if (actingInteractionId) return;
    setActingInteractionId(interaction.id);
    try {
      const res = await fetch(
        `/api/interactions/${encodeURIComponent(interaction.id)}/reply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "操作失败");
      }
      const data = await res.json();
      const updated: InteractionRecord = data.interaction ?? data;
      if (data.event?.seq) {
        latestSeqRef.current = Math.max(latestSeqRef.current, data.event.seq);
      }
      setInteractions((prev) => upsertInteractionList(prev, [updated]));
    } catch (err: any) {
      toast({ body: err?.message || "操作失败", type: "error" });
    } finally {
      setActingInteractionId(null);
    }
  };

  const handleHandoffInteraction = async (
    interaction: InteractionRecord,
    targetHost: HostPresenceInfo
  ) => {
    if (actingInteractionId) return;
    setActingInteractionId(interaction.id);
    try {
      const res = await fetch(
        `/api/interactions/${encodeURIComponent(interaction.id)}/handoff`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetHostId: targetHost.hostId }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "转交在线机器失败");
      }
      const data = await res.json();
      const updated: InteractionRecord = data.interaction ?? data;
      if (Array.isArray(data.hostPresence?.onlineHosts)) {
        setOnlineHosts(data.hostPresence.onlineHosts);
        setPresenceLoaded(true);
      }
      if (data.event?.seq) {
        latestSeqRef.current = Math.max(latestSeqRef.current, data.event.seq);
      }
      setInteractions((prev) => upsertInteractionList(prev, [updated]));
      toast({
        body: `已转交 ${targetHost.hostName} 处理`,
        type: "info",
      });
    } catch (err: any) {
      toast({ body: err?.message || "转交在线机器失败", type: "error" });
    } finally {
      setActingInteractionId(null);
    }
  };

  const threads = useMemo<InteractionThread[]>(() => {
    const map = new Map<string, InteractionRecord[]>();
    for (const item of interactions) {
      const key = item.threadId || item.id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    const list: InteractionThread[] = [];
    for (const [threadId, rawTurns] of map.entries()) {
      const turns = rawTurns
        .slice()
        .sort(
          (a, b) =>
            a.turnIndex - b.turnIndex ||
            (a.createdAt || "").localeCompare(b.createdAt || "")
        );
      list.push({
        threadId,
        turns,
        firstTurn: turns[0]!,
        latestTurn: turns[turns.length - 1]!,
      });
    }
    return list.sort((a, b) =>
      (a.firstTurn.createdAt || "").localeCompare(b.firstTurn.createdAt || "")
    );
  }, [interactions]);

  const handleSheetGrabberPointerDown = (
    e: React.PointerEvent<HTMLDivElement>
  ) => {
    if (!isMobile) return;
    const handle = e.currentTarget;
    const startY = e.clientY;
    let moved = false;
    handle.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientY - startY) > 10) {
        moved = true;
      }
    };

    const onUp = (ev: PointerEvent) => {
      try {
        handle.releasePointerCapture(ev.pointerId);
      } catch {}
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);

      const deltaY = ev.clientY - startY;
      if (!moved || Math.abs(deltaY) < 28) {
        setMobileDetent((prev) =>
          prev === "collapsed" ? "half" : prev === "half" ? "full" : "half"
        );
        return;
      }
      if (deltaY < -36) {
        setMobileDetent((prev) => (prev === "collapsed" ? "half" : "full"));
      } else if (deltaY > 36) {
        if (mobileDetent === "full") {
          setMobileDetent("half");
        } else if (mobileDetent === "half") {
          setMobileDetent("collapsed");
        } else {
          onOpenChange(false);
        }
      }
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  if (!archive) {
    return null;
  }

  const showSelectionActionPill =
    Boolean(selectionAnchor) &&
    (!isOpen || (isMobile && mobileDetent === "collapsed"));

  const openFromSelectionPill = () => {
    onOpenChange(true);
    if (isMobile) {
      setMobileDetent("half");
    }
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 60);
  };

  const selectionPreviewText = selectionAnchor
    ? selectionAnchor.exact.length > 26
      ? `${selectionAnchor.exact.slice(0, 26)}…`
      : selectionAnchor.exact
    : "";

  return (
    <>
      {showSelectionActionPill && selectionAnchor && (
        <div
          className={`hp-selection-pill${
            isOpen && isMobile && mobileDetent === "collapsed"
              ? " above-collapsed-sheet"
              : ""
          }`}
          role="region"
          aria-label="划词留痕快捷操作"
        >
          <button
            type="button"
            className="hp-selection-pill-main"
            onClick={openFromSelectionPill}
          >
            <span className="hp-selection-pill-text">
              💬 留痕：「{selectionPreviewText}」
            </span>
          </button>
          <button
            type="button"
            className="hp-selection-pill-close"
            aria-label="清除划词引用"
            title="取消引用"
            onClick={onClearSelection}
          >
            ×
          </button>
        </div>
      )}

      {isOpen && isMobile && mobileDetent === "full" && (
        <div
          className="hp-interact-backdrop"
          aria-hidden="true"
          onClick={() => setMobileDetent("half")}
        />
      )}

      {isOpen && (
        <aside
          id="interact-drawer"
          className={`hp-interact-drawer ${
            isMobile ? `is-mobile detent-${mobileDetent}` : "is-desktop"
          }`}
          aria-label="留痕面板"
        >
          {isMobile && (
            <div
              className="hp-sheet-grabber-zone"
              role="button"
              tabIndex={0}
              aria-label="切换底部抽屉高度"
              onPointerDown={handleSheetGrabberPointerDown}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setMobileDetent((prev) =>
                    prev === "collapsed"
                      ? "half"
                      : prev === "half"
                      ? "full"
                      : "collapsed"
                  );
                }
              }}
            >
              <span className="hp-sheet-grabber-bar" />
            </div>
          )}

          {isMobile && mobileDetent === "collapsed" ? (
            <div className="hp-sheet-collapsed-bar">
              <button
                type="button"
                className="hp-sheet-collapsed-summary"
                onClick={() => setMobileDetent("half")}
              >
                {queueSummary.activeRunningCount > 0 ? (
                  <>
                    <span className="hp-int-pulse-dot" />
                    <strong>处理中 ({queueSummary.activeRunningCount})</strong>
                  </>
                ) : queueSummary.sleepingCount > 0 ? (
                  <strong>🌙 待唤醒 ({queueSummary.sleepingCount})</strong>
                ) : queueSummary.offlinePendingCount > 0 ? (
                  <strong>⏸ 排队中 ({queueSummary.offlinePendingCount})</strong>
                ) : unreadIds.size > 0 ? (
                  <strong>✨ {unreadIds.size} 条新回复 · 点击查看</strong>
                ) : (
                  <span>
                    留痕{threads.length > 0 ? ` (${threads.length})` : ""}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="hp-int-icon-btn"
                aria-label="关闭留痕面板"
                onClick={() => onOpenChange(false)}
              >
                <CloseSvgIcon />
              </button>
            </div>
          ) : (
            <>
              <header className="hp-interact-header">
                <div className="hp-interact-title-group">
                  <MessageSquareIcon />
                  <strong>留痕</strong>
                  {queueSummary.activeRunningCount > 0 ? (
                    <span className="hp-int-header-working">
                      <span className="hp-int-pulse-dot" />
                      处理中
                    </span>
                  ) : queueSummary.sleepingCount > 0 ? (
                    <span className="hp-int-header-sleeping">
                      🌙 待唤醒 ({queueSummary.sleepingCount})
                    </span>
                  ) : queueSummary.offlinePendingCount > 0 ? (
                    <span className="hp-int-header-sleeping">
                      ⏸ 排队中 ({queueSummary.offlinePendingCount})
                    </span>
                  ) : (
                    activeBinding &&
                    (activeBinding.hostName ||
                      activeBinding.adapterId !== "auto") && (
                      <span
                        className="hp-int-session-tag"
                        title={
                          activeBinding.hostName
                            ? `已绑定 ${activeBinding.hostName}${
                                activeBinding.adapterId !== "auto"
                                  ? ` (${formatAdapterLabel(
                                      activeBinding.adapterId
                                    )})`
                                  : ""
                              }`
                            : `已关联 ${formatAdapterLabel(
                                activeBinding.adapterId
                              )} 会话`
                        }
                      >
                        <span
                          className={`hp-binding-dot${
                            activeBinding.hostId &&
                            presenceLoaded &&
                            !onlineHostIdSet.has(activeBinding.hostId)
                              ? " is-offline"
                              : ""
                          }`}
                        />
                        {activeBinding.hostName ||
                          formatAdapterLabel(activeBinding.adapterId)}
                      </span>
                    )
                  )}
                </div>

                <div className="hp-interact-header-controls">
                  {isMobile && (
                    <div
                      className="hp-detent-pills"
                      role="group"
                      aria-label="抽屉高度切换"
                    >
                      <button
                        type="button"
                        className="hp-detent-chip"
                        onClick={() => setMobileDetent("collapsed")}
                      >
                        收起
                      </button>
                      <button
                        type="button"
                        className={`hp-detent-chip${
                          mobileDetent === "full" ? " is-active" : ""
                        }`}
                        onClick={() =>
                          setMobileDetent((d) =>
                            d === "full" ? "half" : "full"
                          )
                        }
                      >
                        {mobileDetent === "full" ? "半屏" : "全屏"}
                      </button>
                    </div>
                  )}

                  <button
                    type="button"
                    className="hp-int-icon-btn"
                    aria-label="收起留痕面板"
                    title={`收起留痕 (${toggleShortcutLabel} / Esc)`}
                    onClick={() => onOpenChange(false)}
                  >
                    <CloseSvgIcon />
                  </button>
                </div>
              </header>
              <div className="hp-acp-tabs" role="group" aria-label="会话操作">
                <button type="button" className={`hp-btn hp-btn-sm${intent === "change" ? " hp-btn-primary" : ""}`} aria-pressed={intent === "change"} onClick={() => setIntent("change")}>传话给原会话</button>
                <button type="button" className={`hp-btn hp-btn-sm${intent === "question" ? " hp-btn-primary" : ""}`} aria-pressed={intent === "question"} onClick={() => { setIntent("question"); setReplyTarget(null); }}>临时提问</button>
              </div>
              <AcpTranscript acp={acp} temporary={intent === "question"} />

              {activeVersion !== null && activeVersion < latestVersion && (
                <div className="hp-int-newver-banner" role="status">
                  <span>新版本 v{latestVersion} 已就绪</span>
                  <button
                    type="button"
                    className="hp-int-version-pill"
                    onClick={() => onSelectVersion(latestVersion)}
                  >
                    ✨ 查看 v{latestVersion}
                  </button>
                </div>
              )}

              <details
                className="hp-acp-summaries"
                open={!acp.online || interactions.some((i) => i.status === "pending")}
                hidden={intent === "question"}
              >
                <summary>
                  留痕摘要（{threads.length}
                  {interactions.filter((i) => i.status === "pending").length > 0
                    ? ` · ${interactions.filter((i) => i.status === "pending").length} 条排队待送达`
                    : ""}
                  ）
                </summary>
              <div
                ref={threadListRef}
                className="hp-interact-stream"
                role="log"
                aria-live="polite"
              >
                {loadingDocState && threads.length === 0 ? (
                  <div className="hp-inline-loading">
                    <RefreshSvgIcon spinning />
                    <span>同步中…</span>
                  </div>
                ) : threads.length === 0 ? (
                  <div className="hp-interact-empty">
                    <p>暂无留痕</p>
                  </div>
                ) : (
                  threads.map((thread) => {
                    const { firstTurn, latestTurn, turns } = thread;
                    const isResolved = latestTurn.status === "resolved";
                    const isThreadWorking = isWorkingStatus(latestTurn.status);
                    const isThreadHighlighted = turns.some(
                      (t) => t.id === highlightedInteractionId
                    );

                    return (
                      <article
                        key={thread.threadId}
                        id={`interaction-card-${latestTurn.id}`}
                        className={`hp-int-thread-card${
                          isResolved ? " is-resolved" : ""
                        }${isThreadHighlighted ? " is-highlighted" : ""}`}
                      >
                        {firstTurn.anchor && (
                          <blockquote className="hp-int-anchor-quote">
                            <div
                              className="hp-int-anchor-exact"
                              title={firstTurn.anchor.exact}
                            >
                              「{firstTurn.anchor.exact}」
                            </div>
                          </blockquote>
                        )}

                        <div className="hp-int-turns-list">
                          {turns.map((turn, idx) => {
                            const showTurnAnchor =
                              idx > 0 &&
                              turn.anchor &&
                              turn.anchor.exact !== firstTurn.anchor?.exact;

                            return (
                              <div
                                key={turn.id}
                                id={
                                  turn.id !== latestTurn.id
                                    ? `interaction-card-${turn.id}`
                                    : undefined
                                }
                                className="hp-int-turn-item"
                              >
                                <div className="hp-int-user-prompt">
                                  {showTurnAnchor && turn.anchor && (
                                    <div className="hp-int-inline-anchor">
                                      「{turn.anchor.exact}」
                                    </div>
                                  )}
                                  <div className="hp-int-prompt-row">
                                    <p className="hp-int-prompt-text">
                                      {turn.prompt}
                                    </p>
                                    <span className="hp-int-time">
                                      {formatShortTime(turn.createdAt)}
                                    </span>
                                  </div>
                                </div>

                                {isWorkingStatus(turn.status) && (() => {
                                  const {
                                    hostId: turnHostId,
                                    hostName: turnHostName,
                                    isHostOnline: turnHostOnline,
                                  } = resolveTurnHost(turn);
                                  const isSleepingQueue =
                                    turn.status === "pending" &&
                                    Boolean(turnHostId) &&
                                    presenceLoaded &&
                                    !turnHostOnline;
                                  const isNoDaemonOnline =
                                    turn.status === "pending" &&
                                    !turnHostId &&
                                    presenceLoaded &&
                                    onlineHosts.length === 0;
                                  const siblingOnlineHosts = isSleepingQueue
                                    ? onlineHosts.filter(
                                        (h) => h.hostId !== turnHostId
                                      )
                                    : [];

                                  if (isSleepingQueue) {
                                    const hostLabel = turnHostName || "原开发机";
                                    return (
                                      <div
                                        className="hp-int-resting-box is-sleeping"
                                        role="status"
                                      >
                                        <div className="hp-int-resting-title">
                                          🌙 已加入队列 · 等待 {hostLabel} 唤醒后自动处理
                                        </div>
                                        {siblingOnlineHosts.length > 0 && (
                                          <div className="hp-int-handoff-zone">
                                            <div className="hp-int-handoff-actions">
                                              {siblingOnlineHosts.map(
                                                (sibling) => (
                                                  <button
                                                    key={sibling.hostId}
                                                    type="button"
                                                    className="hp-btn hp-btn-sm hp-int-handoff-btn"
                                                    disabled={
                                                      actingInteractionId ===
                                                      turn.id
                                                    }
                                                    onClick={() =>
                                                      void handleHandoffInteraction(
                                                        turn,
                                                        sibling
                                                      )
                                                    }
                                                  >
                                                    改由在线机器 {sibling.hostName} 接手
                                                  </button>
                                                )
                                              )}
                                            </div>
                                            <div className="hp-int-handoff-note">
                                              基于线上最新 HTML 新建会话
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    );
                                  }

                                  if (isNoDaemonOnline) {
                                    return (
                                      <div
                                        className="hp-int-resting-box is-offline"
                                        role="status"
                                      >
                                        <div className="hp-int-resting-title">
                                          ⏸ 已保存留痕 · 等待开发机守护进程上线
                                        </div>
                                      </div>
                                    );
                                  }

                                  return (
                                    <div className="hp-int-working-box">
                                      <span className="hp-int-pulse-dot" />
                                      <span>
                                        {turn.progressText ||
                                          (turnHostName
                                            ? `${turnHostName} 正在处理…`
                                            : "正在处理…")}
                                      </span>
                                    </div>
                                  );
                                })()}

                                {turn.replyText && (
                                  <div className="hp-int-reply-box">
                                    <div className="hp-int-reply-content">
                                      {renderStructuredReply(turn.replyText)}
                                    </div>
                                  </div>
                                )}

                                {typeof turn.resultVersion === "number" &&
                                  turn.resultVersion > 0 && (
                                    <button
                                      type="button"
                                      className={`hp-int-version-pill${
                                        activeVersion === turn.resultVersion
                                          ? " is-current"
                                          : ""
                                      }`}
                                      onClick={() =>
                                        onSelectVersion(turn.resultVersion!)
                                      }
                                    >
                                      ✨ 查看 v{turn.resultVersion}
                                      {activeVersion === turn.resultVersion
                                        ? " · 当前"
                                        : ""}
                                    </button>
                                  )}

                                {(turn.status === "needs_attention" ||
                                  turn.status === "failed") && (
                                  <div
                                    className={`hp-int-alert-box is-${turn.status}`}
                                    role="alert"
                                  >
                                    <p className="hp-int-alert-msg">
                                      {turn.errorMessage ||
                                        "投递未完成，可点击重试"}
                                    </p>
                                    <div className="hp-int-retry-row">
                                      <button
                                        type="button"
                                        className="hp-btn hp-btn-sm hp-btn-primary"
                                        disabled={
                                          actingInteractionId === turn.id
                                        }
                                        onClick={() =>
                                          void handleInteractionAction(
                                            turn,
                                            "retry"
                                          )
                                        }
                                      >
                                        重试
                                      </button>
                                      <button
                                        type="button"
                                        className="hp-btn hp-btn-sm"
                                        disabled={
                                          actingInteractionId === turn.id
                                        }
                                        onClick={() =>
                                          void handleInteractionAction(
                                            turn,
                                            "resolve"
                                          )
                                        }
                                      >
                                        已解决
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        {isResolved ? (
                          <div className="hp-int-resolved-foot">已解决</div>
                        ) : (
                          !isThreadWorking &&
                          latestTurn.status !== "needs_attention" &&
                          latestTurn.status !== "failed" && (
                            <footer className="hp-int-card-foot">
                              <button
                                type="button"
                                className="hp-int-foot-btn"
                                onClick={() => {
                                  setReplyTarget({
                                    threadId: thread.threadId,
                                    nextTurn: latestTurn.turnIndex + 1,
                                  });
                                  textareaRef.current?.focus();
                                }}
                              >
                                追问
                              </button>
                              <button
                                type="button"
                                className="hp-int-foot-btn is-muted"
                                disabled={actingInteractionId === latestTurn.id}
                                onClick={() =>
                                  void handleInteractionAction(
                                    latestTurn,
                                    "resolve"
                                  )
                                }
                              >
                                解决
                              </button>
                            </footer>
                          )
                        )}
                      </article>
                    );
                  })
                )}
              </div>

              </details>

              <form
                className="hp-interact-composer"
                onSubmit={submitInteraction}
              >
                {(queueSummary.sleepingCount > 0 ||
                  queueSummary.offlinePendingCount > 0) &&
                  pushSupported &&
                  !pushSubscribed &&
                  !pushPromptDismissed &&
                  onTogglePush && (
                    <div className="hp-int-push-nudge" role="region" aria-label="离线推送提醒">
                      <span className="hp-int-push-nudge-text">
                        开启离线推送，处理完成时通知
                      </span>
                      <div className="hp-int-push-nudge-actions">
                        <button
                          type="button"
                          className="hp-btn hp-btn-sm hp-btn-primary"
                          disabled={pushBusy}
                          onClick={onTogglePush}
                        >
                          {pushBusy ? "开启中…" : "开启"}
                        </button>
                        <button
                          type="button"
                          className="hp-chip-clear"
                          aria-label="关闭提醒"
                          onClick={() => setPushPromptDismissed(true)}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  )}

                {replyTarget && (
                  <div className="hp-composer-chip hp-composer-thread-chip">
                    <span>追问 #{replyTarget.nextTurn}</span>
                    <button
                      type="button"
                      className="hp-chip-clear"
                      aria-label="取消追问"
                      onClick={() => setReplyTarget(null)}
                    >
                      ×
                    </button>
                  </div>
                )}

                {selectionAnchor && (
                  <div className="hp-composer-chip hp-composer-anchor-chip">
                    <span
                      className="hp-composer-anchor-quote"
                      title={selectionAnchor.exact}
                    >
                      「{selectionAnchor.exact}」
                    </span>
                    <button
                      type="button"
                      className="hp-chip-clear"
                      aria-label="清除划词引用"
                      onClick={onClearSelection}
                    >
                      ×
                    </button>
                  </div>
                )}

                {sendError && (
                  <div className="hp-composer-error" role="alert">
                    <span>{sendError}</span>
                    <button
                      type="button"
                      className="hp-btn hp-btn-sm hp-btn-primary"
                      disabled={sending}
                      onClick={() => void submitInteraction()}
                    >
                      重试
                    </button>
                  </div>
                )}

                <div className="hp-composer-box">
                  <textarea
                    ref={textareaRef}
                    className="hp-composer-textarea"
                    rows={2}
                    placeholder={
                      selectionAnchor
                        ? "针对选中内容输入想法…"
                        : intent === "question"
                          ? "基于当前 HTML 快照只读提问…"
                          : "输入修改意见、问题或下一步指令…"
                    }
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        void submitInteraction();
                        return;
                      }
                      if (
                        e.key === "Escape" &&
                        !e.shiftKey &&
                        !e.altKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        if (replyTarget) {
                          setReplyTarget(null);
                        } else {
                          onOpenChange(false);
                        }
                      }
                    }}
                  />
                  <div className="hp-composer-box-foot">
                    <div className="hp-composer-box-left">
                      {speechSupported && (
                        <button
                          type="button"
                          className={`hp-mic-icon-btn${
                            isListening ? " is-listening" : ""
                          }`}
                          aria-pressed={isListening}
                          aria-label={isListening ? "停止语音听写" : "语音输入"}
                          title={isListening ? "点击停止听写" : "语音输入"}
                          onClick={toggleSpeechInput}
                        >
                          <MicSvgIcon />
                          {isListening && <span>录音中</span>}
                        </button>
                      )}
                    </div>
                    <button
                      type="submit"
                      className="hp-btn hp-btn-sm hp-btn-primary hp-composer-send-btn"
                      title={`发送 (${sendShortcutLabel})`}
                      disabled={sending || !prompt.trim() || (intent === "question" && acp.state?.status !== "ready")}
                    >
                      {sending ? "发送中…" : "发送"}
                    </button>
                  </div>
                </div>
              </form>
            </>
          )}
        </aside>
      )}
    </>
  );
}
