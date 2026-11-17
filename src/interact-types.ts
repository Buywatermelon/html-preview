/**
 * Core contract for bidirectional HTML <-> Local Daemon coding-agent interactions
 * across Desktop & Mobile PWA, shared 1:1 between Cloudflare Worker and Self-hosted Node.
 */

export interface HostPresenceInfo {
  hostId: string;
  hostName: string;
  daemonVersion?: string;
  connectedAt: string;
  lastSeenAt: string;
}

export interface HostPresenceSummary {
  targetHostId: string | null;
  targetHostName: string | null;
  targetHostOnline: boolean;
  onlineHostCount: number;
  onlineHosts: HostPresenceInfo[];
}

export interface PresenceSnapshot {
  activeBrowserCount: number;
  onlineHosts: HostPresenceInfo[];
}

export interface NotifyOptions {
  targetRole?: "browser" | "daemon" | "all";
  targetHostId?: string | null;
}

export interface SessionBindingInput {
  hostId?: string | null;
  hostName?: string | null;
  opaqueBinding?: string | null;
  adapterId?: string;
  sessionRef?: string;
  cwd?: string | null;
  sourceFile?: string | null;
  adapterMeta?: Record<string, unknown>;
  version?: number;
}

export interface SessionBinding {
  id: string;
  documentId: string;
  version: number;
  hostId: string | null;
  hostName: string | null;
  opaqueBinding: string | null;
  adapterId: string;
  sessionRef: string;
  cwd: string | null;
  sourceFile: string | null;
  adapterMeta: Record<string, unknown>;
  createdAt: string;
}

export interface SelectionAnchor {
  entryPath: string;
  exact: string;
  prefix?: string;
  suffix?: string;
  elementSelector?: string;
}

export type InteractionIntent = "change" | "question";

export type InteractionStatus =
  | "pending"
  | "leased"
  | "dispatched"
  | "working"
  | "replied"
  | "updated"
  | "needs_attention"
  | "failed"
  | "resolved";

export type InteractionEventKind =
  | "created"
  | "leased"
  | "dispatched"
  | "working"
  | "replied"
  | "version_linked"
  | "needs_attention"
  | "failed"
  | "resolved";

export interface InteractionRecord {
  id: string;
  threadId: string;
  turnIndex: number;
  documentId: string;
  baseVersion: number;
  requestId: string;
  anchor: SelectionAnchor | null;
  intent: InteractionIntent;
  prompt: string;
  targetHostId?: string | null;
  targetHostName?: string | null;
  targetAdapterId: string;
  effectiveAdapterId: string | null;
  status: InteractionStatus;
  progressText: string | null;
  replyText: string | null;
  resultVersion: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InteractionStreamEvent {
  seq: number;
  documentId: string;
  interactionId: string;
  eventKey: string;
  kind: InteractionEventKind;
  summary?: string;
  replyText?: string | null;
  resultVersion?: number | null;
  status?: InteractionStatus;
  effectiveAdapterId?: string | null;
  createdAt: string;
}

export interface InteractionEnvelope {
  interactionId: string;
  threadId: string;
  turnIndex: number;
  deliveryId: string;
  attempt: number;
  fencingToken: string;
  document: {
    id: string;
    publicId: string;
    name: string;
    title: string;
    baseVersion: number;
    versionUrl: string;
  };
  binding: SessionBinding;
  anchor: SelectionAnchor | null;
  intent: InteractionIntent;
  ownerPrompt: string;
  previousTurns?: Array<{
    turnIndex: number;
    prompt: string;
    replyText: string | null;
    resultVersion: number | null;
  }>;
  createdAt: string;
}

export interface AgentSessionSummary {
  adapterId: string;
  sessionRef: string;
  cwd: string | null;
  updatedAt: string;
}

export interface ArtifactSourceLocation {
  cwd: string | null;
  sourceFile: string | null;
  handoffMaterialized?: boolean;
}

export interface CodingAgentSendContext {
  envelope: InteractionEnvelope;
  envelopePath: string;
  source: ArtifactSourceLocation;
  abortSignal?: AbortSignal;
  onWorking?: (detail: string) => Promise<void>;
  runAcp?: (request: {
    adapterId: string; sessionRef?: string; cwd?: string; readOnly: boolean; promptText: string; contextKey: string;
  }) => Promise<CodingAgentReply>;
}

export interface CodingAgentReply {
  replyText: string;
  sessionRef?: string;
  resumed: boolean;
  newVersion?: number;
  receipt?: Record<string, unknown>;
}

/**
 * Minimal coding-agent adapter contract (no terminal orchestrators):
 * 1. Send a message into an agent session and await the complete reply (`sendMessage`)
 * 2. List resumable sessions (`listSessions`)
 * 3. Locate the HTML artifact source (`locateArtifactSource`)
 */
export interface CodingAgentAdapter {
  readonly id: string;
  readonly displayName: string;
  probe(): Promise<{ available: boolean; version?: string; reason?: string }>;
  sendMessage(ctx: CodingAgentSendContext): Promise<CodingAgentReply>;
  listSessions(opts?: { cwd?: string; limit?: number }): Promise<AgentSessionSummary[]>;
  locateArtifactSource(envelope: InteractionEnvelope): Promise<ArtifactSourceLocation>;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string;
}

export interface PushSubscriptionRecord {
  id: string;
  ownerId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RealtimeEvent =
  | {
      type: "upload";
      id: string;
      name: string;
      title: string;
      folder: string;
      shared?: boolean;
      shareUrl?: string | null;
      version: number;
      url: string;
      versionUrl: string;
    }
  | {
      type: "interaction";
      seq: number;
      documentId: string;
      kind: InteractionEventKind;
      interaction: InteractionRecord;
    }
  | {
      type: "daemon_wake";
      targetHostId: string | null;
      documentId: string;
      interactionId: string;
      targetAdapterId?: string;
    }
  | {
      type: "host_presence";
      hosts: HostPresenceInfo[];
    };
