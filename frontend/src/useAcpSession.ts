import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AcpAgentStatus, AcpClientCommand, AcpClientFrame, AcpPermission, AcpServerFrame, AcpSessionState } from "../../src/acp-types";
import type { HostPresenceInfo, SelectionAnchor, SessionBinding } from "./types";
import { applyStream, emptyTranscript, type Transcript } from "./acp-transcript";

export function useAcpSession(opts: {
  open: boolean; documentId?: string; version: number; intent: "change" | "question";
  binding: SessionBinding | null; hosts: HostPresenceInfo[]; reconnect: number;
  send(frame: AcpClientFrame): boolean;
}) {
  const [agents, setAgents] = useState<Record<string, AcpAgentStatus[]>>({});
  const [manualAgent, setManualAgent] = useState("");
  const [state, setState] = useState<AcpSessionState | null>(null);
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript);
  const [permissions, setPermissions] = useState<AcpPermission[]>([]);
  const [error, setError] = useState("");
  const current = useRef<{ key?: string; requestId?: string; sessionId?: string; adapterId?: string; host?: string; ephemeral?: boolean }>({});
  const model = useRef(transcript); model.current = transcript;
  const question = useRef<{ doc?: string; choice?: string; key: string; sessionId?: string }>({ key: `question:${crypto.randomUUID()}` });
  const choices = useMemo(() => [...opts.hosts].sort((a, b) => Number(b.hostId === opts.binding?.hostId) - Number(a.hostId === opts.binding?.hostId))
    .flatMap(h => (agents[h.hostId] || []).filter(a => a.readOnly).map(a => ({ ...a, hostId: h.hostId, hostName: h.hostName, value: `${h.hostId}|${a.id}` }))), [opts.hosts, opts.binding?.hostId, agents]);
  const chosen = choices.find(c => c.value === manualAgent && c.available) || choices.find(c => c.available);
  const host = opts.intent === "question" ? chosen?.hostId : opts.binding?.hostId || undefined;
  const online = Boolean(host && opts.hosts.some(h => h.hostId === host));
  const command = useCallback((partial: Omit<AcpClientCommand, "type" | "targetHostId">) => {
    const c = current.current;
    if (!c.host) return false;
    return opts.send({ type: "acp_client_cmd", targetHostId: c.host, documentId: opts.documentId, version: opts.version,
      sessionKey: c.key, sessionId: c.sessionId, adapterId: c.adapterId, ephemeral: c.ephemeral, ...partial });
  }, [opts.send, opts.documentId, opts.version]);

  const receive = useCallback((frame: AcpServerFrame) => {
    if (frame.type === "acp_session_state" && frame.status === "agents") {
      if (frame.hostId && frame.agents) setAgents(old => ({ ...old, [frame.hostId!]: frame.agents! })); return;
    }
    const c = current.current;
    if (frame.hostId && frame.hostId !== c.host || frame.type === "acp_error" && frame.targetHostId && frame.targetHostId !== c.host) return;
    if (frame.type === "acp_error") {
      if (frame.requestId && frame.requestId !== c.requestId || frame.sessionKey && c.key && frame.sessionKey !== c.key) return;
      setError(frame.code === "HOST_OFFLINE" ? "宿主机已离线；原会话留言仍可排队" : frame.message || frame.code); return;
    }
    if (frame.type === "acp_session_state" && frame.requestId === c.requestId) c.key = frame.sessionKey;
    if (!c.key || frame.sessionKey !== c.key) return;
    if (frame.type === "acp_stream_event") {
      setTranscript(previous => applyStream(previous, frame));
      if (frame.reset) setPermissions([]);
    } else if (frame.type === "acp_session_state") {
      c.sessionId = frame.sessionId; c.adapterId = frame.adapterId;
      if (c.ephemeral) question.current.sessionId = frame.sessionId;
      setState(frame); if (frame.status !== "error") setError("");
      if (["ready", "closed", "error", "spectating"].includes(frame.status)) setPermissions([]);
    } else if (frame.type === "acp_permission_request") setPermissions(old => [...old.filter(p => p.permissionId !== frame.permissionId), frame]);
  }, []);

  const hostsKey = opts.hosts.map(h => h.hostId).sort().join(",");
  useEffect(() => {
    if (!opts.open) return;
    for (const h of opts.hosts) opts.send({ type: "acp_client_cmd", action: "agents", targetHostId: h.hostId });
  }, [opts.open, hostsKey, opts.reconnect, opts.send]);

  useEffect(() => {
    if (!opts.open || !opts.documentId || !host || !online) { setState(null); return; }
    const ephemeral = opts.intent === "question";
    const choice = chosen?.value;
    if (ephemeral && (question.current.doc !== opts.documentId || question.current.choice !== choice)) {
      question.current = { doc: opts.documentId, choice, key: `question:${crypto.randomUUID()}` };
    }
    const requestId = crypto.randomUUID();
    current.current = { key: ephemeral ? question.current.key : undefined, host, ephemeral, requestId,
      sessionId: ephemeral ? question.current.sessionId : undefined, adapterId: ephemeral ? chosen?.id : undefined };
    setState(null); setError(""); setPermissions([]); setTranscript(emptyTranscript());
    command({ action: "open_session", requestId });
    const sync = () => { if (!document.hidden) command({ action: "sync_session", afterSeq: model.current.seq, epoch: model.current.epoch }); };
    const heartbeat = setInterval(sync, 25_000);
    document.addEventListener("visibilitychange", sync); window.addEventListener("focus", sync);
    return () => {
      command({ action: "unsubscribe" }); clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", sync); window.removeEventListener("focus", sync);
    };
  }, [opts.open, opts.documentId, opts.version, opts.intent, opts.binding?.id, host, online, chosen?.value, command]);

  useEffect(() => {
    if (opts.open && current.current.key && opts.reconnect > 0) command({ action: "sync_session", afterSeq: model.current.seq, epoch: model.current.epoch });
  }, [opts.reconnect, opts.open, command]);

  return { receive, state, transcript, permissions, error, choices, chosen, manualAgent, setManualAgent, online,
    sendPrompt: (prompt: string, anchor: SelectionAnchor | null) => command({ action: "prompt", prompt, anchor: anchor || undefined }),
    cancel: () => command({ action: "cancel" }), takeover: () => command({ action: "takeover" }), setMode: (modeId: string) => command({ action: "set_mode", modeId }),
    respond: (p: AcpPermission, optionId?: string) => {
      const c = current.current; if (!c.host || !c.key) return;
      opts.send({ type: "acp_permission_response", targetHostId: c.host, sessionKey: c.key, permissionId: p.permissionId,
        outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
      setPermissions(old => old.filter(item => item.permissionId !== p.permissionId));
    },
  };
}
