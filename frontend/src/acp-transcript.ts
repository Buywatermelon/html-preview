import type { AcpServerFrame, AcpUpdate } from "../../src/acp-types";
export interface TranscriptRow { id: string; kind: string; update: AcpUpdate }
export interface Transcript {
  epoch?: string;
  seq: number;
  rows: TranscriptRow[];
  fragments: Map<string, string[]>;
}
export const emptyTranscript = (): Transcript => ({ seq: 0, rows: [], fragments: new Map() });

/** ACP stays structured through the relay; only the view groups chunks into messages. */
export function applyStream(previous: Transcript, frame: Extract<AcpServerFrame, { type: "acp_stream_event" }>): Transcript {
  let model = frame.reset || frame.epoch !== previous.epoch ? emptyTranscript() : previous;
  model = { ...model, epoch: frame.epoch, rows: [...model.rows], fragments: new Map(model.fragments) };
  const append = (u: AcpUpdate) => {
    if (u.sessionUpdate === "html_preview_fragment") {
      const key = String(u.fragmentId), index = Number(u.index), total = Number(u.total);
      const parts = [...(model.fragments.get(key) || [])]; parts[index] = String(u.data); model.fragments.set(key, parts);
      if (parts.filter(p => p !== undefined).length === total) {
        model.fragments.delete(key);
        try { append(JSON.parse(parts.join(""))); } catch {}
      }
      return;
    }
    const kind = u.sessionUpdate;
    const last = model.rows.at(-1);
    const content = u.content as { type?: string; text?: string } | undefined;
    if (/_chunk$/.test(kind) && content?.type === "text") {
      if (last?.kind === kind && last.update.messageId === u.messageId) {
        const old = last.update.content as { type: string; text: string };
        model.rows[model.rows.length - 1] = { ...last, update: { ...last.update, content: { ...old, text: old.text + (content.text || "") } } };
      } else model.rows.push({ id: `message-${model.seq}`, kind, update: u });
    } else if (kind === "tool_call_update") {
      const index = model.rows.findIndex(r => r.kind === "tool_call" && r.update.toolCallId === u.toolCallId);
      if (index >= 0) model.rows[index] = { ...model.rows[index], update: { ...model.rows[index].update, ...u, sessionUpdate: "tool_call" } };
      else model.rows.push({ id: `tool-${model.seq}`, kind: "tool_call", update: u });
    } else model.rows.push({ id: `event-${model.seq}`, kind, update: u });
  };
  for (const event of frame.events) {
    if (event.seq <= model.seq) continue;
    model.seq = event.seq; append(event.update);
  }
  return model;
}
