/** Pure, account-scoped memory relay. Callers supply only authenticated peers. */
export interface RelayPeer {
  role: "browser" | "daemon";
  hostId?: string;
  clientId?: string;
  send(data: string): void;
}
const outbound = new Set(["acp_stream_event", "acp_permission_request", "acp_session_state", "acp_error"]);
const actions = new Set(["agents", "open_session", "prompt", "cancel", "takeover", "set_mode", "sync_session", "unsubscribe"]);
const token = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,180}$/.test(v);
const send = (peer: RelayPeer, data: string) => { try { peer.send(data); return true; } catch { return false; } };

export function relayRealtimeSocketFrame(sender: RelayPeer, raw: string, peers: () => Iterable<RelayPeer>): boolean {
  if (raw.length > 65_536 || new TextEncoder().encode(raw).byteLength > 65_536) return false;
  let f: Record<string, unknown>;
  try { f = JSON.parse(raw); } catch { return false; }
  if (!f || Array.isArray(f) || typeof f !== "object") return false;
  if (sender.role === "daemon" && token(sender.hostId) && outbound.has(String(f.type))) {
    if (f.type !== "acp_error" && !token(f.sessionKey)) return false;
    if (f.type === "acp_stream_event" && (!token(f.epoch) || !Array.isArray(f.events) || f.events.length > 2000 ||
      !f.events.every(e => e && Number.isSafeInteger(e.seq) && e.seq > 0 && ["replay", "live"].includes(e.phase) && typeof e.update?.sessionUpdate === "string"))) return false;
    if (f.type === "acp_permission_request" && (!token(f.permissionId) || !Array.isArray(f.options) || !f.toolCall)) return false;
    if (f.type === "acp_session_state" && !["loading", "ready", "busy", "spectating", "closed", "error", "agents"].includes(String(f.status))) return false;
    const data = JSON.stringify({ ...f, hostId: sender.hostId });
    for (const peer of peers()) if (peer.role === "browser" && (!f.targetClientId || peer.clientId === f.targetClientId)) send(peer, data);
    return true;
  }
  if (sender.role !== "browser" || !sender.clientId || !token(f.targetHostId)) return false;
  if (f.type === "acp_client_cmd") {
    if (!actions.has(String(f.action)) || (f.prompt !== undefined && (typeof f.prompt !== "string" || f.prompt.length > 16000)) ||
      (f.afterSeq !== undefined && (!Number.isSafeInteger(f.afterSeq) || Number(f.afterSeq) < 0))) return false;
  } else if (f.type === "acp_permission_response") {
    const o = f.outcome as { outcome?: string; optionId?: string } | undefined;
    if (!token(f.sessionKey) || !token(f.permissionId) || !o || !(o.outcome === "cancelled" || (o.outcome === "selected" && token(o.optionId)))) return false;
  } else return false;
  const data = JSON.stringify({ ...f, clientId: sender.clientId });
  let delivered = false;
  for (const peer of peers()) if (peer.role === "daemon" && peer.hostId === f.targetHostId) delivered = send(peer, data) || delivered;
  if (!delivered) send(sender, JSON.stringify({ type: "acp_error", code: "HOST_OFFLINE", targetHostId: f.targetHostId, requestId: f.requestId, sessionKey: f.sessionKey }));
  return true;
}
