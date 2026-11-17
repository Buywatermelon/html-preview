#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "--version" || args[0] === "-v") {
  process.stdout.write("mock-acp-agent 1.0.0\n");
  process.exit(0);
}

const logFile = process.env.ACP_LOG_FILE || "";
const log = (entry) => {
  if (!logFile) return;
  appendFileSync(logFile, JSON.stringify({ pid: process.pid, args, ...entry }) + "\n");
};

const lines = readline.createInterface({ input: process.stdin });
const send = v => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...v }) + "\n");
let activeSessionId = "test-session";
const update = u => send({ method: "session/update", params: { sessionId: activeSessionId, update: u } });
const waitingTurns = [];
let permission;
let mode = args.includes("html-preview-readonly") ? "read-only" : "agent";
const modes = () => ({ currentModeId: mode, availableModes: ["agent", "read-only", "plan"].map(id => ({ id, name: id })) });

for await (const line of lines) {
  const f = JSON.parse(line);
  if (f.id === "permission") { permission?.(f.result); continue; }
  log({ method: f.method, params: f.params });
  const reply = result => send({ id: f.id, result });
  if (f.method === "initialize") {
    if (f.params.protocolVersion !== 1 || Object.keys(f.params.clientCapabilities).length) process.exit(2);
    reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } } });
  } else if (f.method === "session/new") {
    reply({ sessionId: activeSessionId, modes: modes() });
  } else if (f.method === "session/load") {
    if (typeof f.params?.sessionId === "string" && f.params.sessionId) activeSessionId = f.params.sessionId;
    update({ sessionUpdate: "user_message_chunk", messageId: "history-user", content: { type: "text", text: "history" } });
    update({ sessionUpdate: "tool_call", toolCallId: "read", title: "Read file", status: "completed", rawInput: { path: "index.html" } });
    update({ sessionUpdate: "tool_call_update", toolCallId: "read", content: [{ type: "content", content: { type: "text", text: "full output" } }] });
    update({ sessionUpdate: "agent_message_chunk", messageId: "history-agent", content: { type: "text", text: "loaded answer" } });
    reply({ modes: modes() });
  } else if (f.method === "session/set_mode") {
    mode = f.params.modeId;
    reply({});
  } else if (f.method === "session/resume" || f.method === "session/close") {
    reply({});
  } else if (f.method === "session/cancel") {
    while (waitingTurns.length > 0) {
      const turnId = waitingTurns.shift();
      send({ id: turnId, result: { stopReason: "cancelled" } });
    }
  } else if (f.method === "session/prompt") {
    const turnId = f.id;
    const text = f.params.prompt[0].text;
    if (text === "wait") {
      waitingTurns.push(turnId);
      continue;
    }
    if (text === "permission") {
      // Keep consuming stdin so the client can answer the permission request.
      permission = result => {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(result) } });
        send({ id: turnId, result: { stopReason: "end_turn" } });
      };
      send({ id: "permission", method: "session/request_permission", params: { sessionId: activeSessionId,
        toolCall: { toolCallId: "write", kind: "edit", title: "Write file" }, options: [{ kind: "allow_once", optionId: "allow", name: "Allow" }, { kind: "reject_once", optionId: "reject", name: "Reject" }] } });
      continue;
    }
    if (text === "large") update({ sessionUpdate: "tool_call", toolCallId: "large", title: "Large output", rawOutput: "汉字🌏".repeat(14000) });
    for (const chunk of ["stream ", mode, " answer"]) update({ sessionUpdate: "agent_message_chunk", messageId: `turn-${f.id}`, content: { type: "text", text: chunk } });
    reply({ stopReason: "end_turn" });
  } else if (f.id != null) {
    send({ id: f.id, error: { code: -32601, message: "Not found" } });
  }
}
