import React, { useEffect, useRef } from "react";
import type { useAcpSession } from "./useAcpSession";

const json = (v: unknown) => typeof v === "string" ? v : JSON.stringify(v, null, 2);
function Content({ value }: { value: any }): React.ReactNode {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map((v, i) => <Content key={i} value={v} />);
  if (typeof value === "string") return <pre>{value}</pre>;
  if (value.type === "content") return <Content value={value.content} />;
  if (value.type === "text") return <pre>{value.text}</pre>;
  if (value.type === "image" && /^image\/(png|jpeg|webp|gif)$/.test(value.mimeType)) return <img alt="会话图片" src={`data:${value.mimeType};base64,${value.data}`} />;
  if (value.type === "diff") return <div><strong>{value.path}</strong><pre>{value.oldText}</pre><pre>{value.newText}</pre></div>;
  return <pre>{json(value)}</pre>;
}
export function AcpTranscript({ acp, temporary }: { acp: ReturnType<typeof useAcpSession>; temporary: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => { if (follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [acp.transcript.seq]);
  const statusLabel = acp.state?.status === "busy"
    ? (acp.state.shared ? "共享会话 · 正在回答" : "正在回答")
    : acp.state?.status === "spectating"
      ? (acp.state.takeoverPending ? "等待本轮结束后接管" : "终端占用 · 实时旁观")
      : acp.state?.status === "ready"
        ? (acp.state.shared ? "共享同步中" : "已连接")
        : acp.online ? "加载中…" : "宿主机离线";
  return <section className="hp-acp-session" aria-label={temporary ? "只读临时会话" : "原会话"}>
    <div className="hp-acp-controls">
      <span>{temporary ? "只读临时会话" : "原会话"} · {statusLabel}</span>
      {temporary && <select aria-label="临时提问 Agent" value={acp.chosen?.value || ""} onChange={e => acp.setManualAgent(e.target.value)}>
        {!acp.chosen && <option value="">暂无已登录 Agent</option>}
        {acp.choices.map(c => <option key={c.value} value={c.value} disabled={!c.available}>{c.hostName} · {c.name}{c.available ? "" : `（${c.reason || "不可用"}）`}</option>)}
      </select>}
      {!temporary && acp.state?.modes && <select aria-label="会话模式" value={acp.state.modes.currentModeId} disabled={acp.state.status !== "ready"} onChange={e => acp.setMode(e.target.value)}>
        {acp.state.modes.availableModes.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>}
      {!temporary && acp.state?.status === "spectating" && acp.state.canTakeover && (
        <button
          type="button"
          className="hp-btn hp-btn-sm hp-btn-primary"
          disabled={Boolean(acp.state.takeoverPending)}
          onClick={acp.takeover}
        >
          {acp.state.takeoverPending
            ? "等待本轮结束…"
            : acp.state.terminalBusy
              ? "本轮结束后接管"
              : "由网页接管"}
        </button>
      )}
      {acp.state?.status === "busy" && <button type="button" className="hp-btn hp-btn-sm" onClick={acp.cancel}>停止</button>}
    </div>
    {acp.state?.status === "spectating" && <p className="hp-acp-notice" role="status">{acp.state.message}</p>}
    {!acp.online && <p className="hp-acp-notice">{temporary ? "暂无在线机器可提问" : "宿主机离线，新留言将排队送达"}</p>}
    {acp.error && <p className="hp-composer-error" role="alert">{acp.error}</p>}
    <div className="hp-acp-transcript" ref={scroller} onScroll={() => { const e = scroller.current; if (e) follow.current = e.scrollHeight - e.scrollTop - e.clientHeight < 80; }}>
      {acp.transcript.rows.map(row => {
        const u = row.update;
        if (row.kind === "html_preview_turn_end") return <hr key={row.id} />;
        if (row.kind === "tool_call") return <details key={row.id} className="hp-acp-tool"><summary>{String(u.title || u.toolCallId || "工具调用")} · {String(u.status || "")}</summary>
          <Content value={u.content} />{u.rawInput !== undefined && <details><summary>输入</summary><Content value={u.rawInput} /></details>}
          {u.rawOutput !== undefined && <Content value={u.rawOutput} />}<details><summary>完整工具数据</summary><pre>{json(u)}</pre></details>
        </details>;
        if (row.kind === "agent_thought_chunk") return <details key={row.id} className="hp-acp-thought"><summary>思考</summary><Content value={u.content} /></details>;
        if (row.kind === "user_message_chunk" || row.kind === "agent_message_chunk") return <article key={row.id} className={`hp-acp-message ${row.kind === "user_message_chunk" ? "is-user" : ""}`}><small>{row.kind === "user_message_chunk" ? "你" : "Agent"}</small><Content value={u.content} /></article>;
        return <details key={row.id} className="hp-acp-event"><summary>{row.kind}</summary><pre>{json(u)}</pre></details>;
      })}
    </div>
    {acp.permissions.map(p => <div key={p.permissionId} className="hp-acp-permission" role="alert"><strong>权限请求：{String(p.toolCall.title || "工具调用")}</strong><details><summary>详情</summary><pre>{json(p.toolCall)}</pre></details>
      <div>{p.options.map(o => <button type="button" className="hp-btn hp-btn-sm" key={o.optionId} onClick={() => acp.respond(p, o.optionId)}>{o.name}</button>)}<button type="button" className="hp-btn hp-btn-sm" onClick={() => acp.respond(p)}>取消请求</button></div>
    </div>)}
  </section>;
}
