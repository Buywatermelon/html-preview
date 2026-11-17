/** Wire frames shared by the browser, daemon and both stateless WS relays. */
export type AcpUpdate = { sessionUpdate: string; [key: string]: unknown };
export interface AcpStreamItem { seq: number; phase: "replay" | "live"; update: AcpUpdate }
export interface AcpAgentStatus {
  id: string;
  name: string;
  available: boolean;
  readOnly: boolean;
  version?: string;
  reason?: string;
}
export interface AcpPermission {
  permissionId: string;
  toolCall: Record<string, unknown>;
  options: Array<{ optionId: string; name: string; kind: string }>;
}
export interface AcpSessionState {
  type: "acp_session_state";
  hostId?: string;
  targetClientId?: string;
  requestId?: string;
  sessionKey: string;
  sessionId?: string;
  adapterId?: string;
  epoch?: string;
  status: "loading" | "ready" | "busy" | "spectating" | "closed" | "error" | "agents";
  readOnly?: boolean;
  shared?: boolean;
  canTakeover?: boolean;
  terminalBusy?: boolean;
  takeoverPending?: boolean;
  message?: string;
  modes?: { currentModeId: string; availableModes: Array<{ id: string; name: string }> };
  agents?: AcpAgentStatus[];
}
export type AcpServerFrame = AcpSessionState | {
  type: "acp_stream_event";
  hostId?: string;
  targetClientId?: string;
  sessionKey: string;
  epoch: string;
  reset?: boolean;
  events: AcpStreamItem[];
} | (AcpPermission & {
  type: "acp_permission_request";
  hostId?: string;
  targetClientId?: string;
  sessionKey: string;
  epoch: string;
}) | {
  type: "acp_error";
  hostId?: string;
  targetHostId?: string;
  targetClientId?: string;
  requestId?: string;
  sessionKey?: string;
  code: string;
  message?: string;
};
export interface AcpClientCommand {
  type: "acp_client_cmd";
  action: "agents" | "open_session" | "prompt" | "cancel" | "takeover" | "set_mode" | "sync_session" | "unsubscribe";
  targetHostId: string;
  clientId?: string;
  requestId?: string;
  sessionKey?: string;
  sessionId?: string;
  adapterId?: string;
  documentId?: string;
  version?: number;
  ephemeral?: boolean;
  afterSeq?: number;
  epoch?: string;
  modeId?: string;
  prompt?: string;
  anchor?: { entryPath: string; exact: string; prefix?: string; suffix?: string; elementSelector?: string };
}
export interface AcpPermissionResponse {
  type: "acp_permission_response";
  targetHostId: string;
  clientId?: string;
  sessionKey: string;
  permissionId: string;
  outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string };
}
export type AcpClientFrame = AcpClientCommand | AcpPermissionResponse;
