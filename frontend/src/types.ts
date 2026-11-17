export interface SessionUser {
  id: string;
  login: string;
  github_id?: string | null;
  avatarUrl?: string;
}

export interface SessionResponse {
  authenticated: boolean;
  user: SessionUser | null;
}

export interface DeviceVerificationInfo {
  userCode: string;
  clientName: string;
  status: "pending" | "approved" | "denied" | "consumed";
  expiresAt: string;
}

export interface DeviceApproveResponse {
  ok: boolean;
  status: "approved" | "denied";
}

export interface DeviceTokenItem {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt?: string | null;
}

export interface DeviceTokensResponse {
  tokens: DeviceTokenItem[];
}

export interface CreateDeviceTokenResponse {
  token: string;
  item?: DeviceTokenItem;
}

export interface VersionItem {
  version: number;
  createdAt: string;
  note: string;
  fileCount: number;
  totalBytes: number;
}

export interface ArchiveItem {
  id: string;
  publicId: string;
  name: string;
  title: string;
  folder: string;
  createdAt: string;
  updatedAt: string;
  versions: VersionItem[];
  shared?: boolean;
  shareUrl?: string | null;
  sharedAt?: string | null;
}

export interface ShareResponse {
  id: string;
  name: string;
  title: string;
  folder: string;
  shared: boolean;
  shareUrl: string | null;
  sharedAt: string | null;
}

export interface ProjectItem {
  name: string;
  createdAt?: string;
  tasks: string[];
}

export interface CatalogResponse {
  archives: ArchiveItem[];
  projects?: ProjectItem[];
  user?: SessionUser;
}

export interface UploadEvent {
  type: "upload";
  id: string;
  name?: string;
  title: string;
  folder: string;
  version: number;
  url: string;
  versionUrl: string;
}

export interface SelectionAnchor {
  entryPath: string;
  exact: string;
  prefix?: string;
  suffix?: string;
  elementSelector?: string;
}

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

export interface SessionBinding {
  id: string;
  documentId: string;
  version: number;
  hostId?: string | null;
  hostName?: string | null;
  opaqueBinding?: string | null;
  adapterId: string;
  sessionRef: string;
  cwd: string | null;
  sourceFile: string | null;
  adapterMeta: Record<string, unknown>;
  createdAt: string;
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

export interface DocumentInteractionsResponse {
  bindings: SessionBinding[];
  interactions: InteractionRecord[];
  events: InteractionStreamEvent[];
  latestSeq: number;
  onlineHosts?: HostPresenceInfo[];
  hostPresence?: HostPresenceSummary;
}

export interface PushSubscriptionItem {
  id: string;
  ownerId?: string;
  endpoint: string;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RealtimeInteractionMessage {
  type: "interaction";
  seq: number;
  documentId: string;
  kind: InteractionEventKind;
  interaction: InteractionRecord;
}

export interface RealtimeHostPresenceMessage {
  type: "host_presence";
  hosts: HostPresenceInfo[];
}

export type RealtimeDrawerMessage =
  | import("../../src/acp-types").AcpServerFrame
  | RealtimeInteractionMessage
  | RealtimeHostPresenceMessage;

export type ThemePreference = "light" | "dark" | "system";
