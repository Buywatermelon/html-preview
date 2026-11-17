import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { AcpPermission, AcpServerFrame, AcpSessionState, AcpStreamItem, AcpUpdate } from "../acp-types";
import { startAcpProcess, type AcpLaunchOptions, type AcpProcess } from "./acp-process";
import {
  acquireCooperativeSessionLock,
  alive,
  inspectSessionOwner,
  procStartTime,
  sessionFile,
  SessionFileTail,
  statStamp,
  terminalOwnsSession,
  transcriptUpdates,
  type CooperativeLockHandle,
  type SessionOwnerInspection,
  type SharedExecutorEndpoint,
} from "./session-files";

export const TERMINAL_MESSAGE = "终端正在使用此会话；网页可直接发消息排队，终端释放后自动送达";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class SessionRingBuffer {
  private items: Array<{ event: AcpStreamItem; bytes: number }> = [];
  private bytes = 0;
  private nextSeq = 1;
  constructor(private maxEntries = 2000, private maxBytes = 2 * 1024 * 1024) {}
  append(update: AcpUpdate, phase: "replay" | "live"): AcpStreamItem {
    const event = { seq: this.nextSeq++, phase, update };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.items.push({ event, bytes });
    this.bytes += bytes;
    while (this.items.length && (this.items.length > this.maxEntries || this.bytes > this.maxBytes)) {
      this.bytes -= this.items.shift()!.bytes;
    }
    return event;
  }
  after(seq: number): AcpStreamItem[] | null {
    if (seq > this.nextSeq - 1 || seq < (this.items[0]?.event.seq ?? this.nextSeq) - 1) return null;
    return this.items.filter(i => i.event.seq > seq).map(i => i.event);
  }
  clear(): void {
    this.items = [];
    this.bytes = 0;
  }
}

export interface OpenAcpSession {
  sessionKey: string;
  adapterId: string;
  sessionId?: string;
  cwd: string;
  readOnly: boolean;
  clientId?: string;
  requestId?: string;
  afterSeq?: number;
  epoch?: string;
}

interface WarmSession extends OpenAcpSession {
  epoch: string;
  ring: SessionRingBuffer;
  status: AcpSessionState["status"];
  phase: "replay" | "live";
  shared: boolean;
  process?: AcpProcess;
  lockHandle?: CooperativeLockHandle;
  fileStamp?: string;
  ownerInfo?: SessionOwnerInspection;
  takeoverPending: boolean;
  takeoverDeadline?: number;
  takingOver: boolean;
  customMessage?: string;
  ready?: Promise<void>;
  modes?: AcpSessionState["modes"];
  queue: AcpUpdate[];
  batchTimer?: ReturnType<typeof setTimeout>;
  tail?: SessionFileTail;
  subscribers: Map<string, number>;
  permissions: Map<string, AcpPermission & { resolve: (result: RequestPermissionResponse) => void }>;
  lastUsed: number;
  turnBuffer: string;
  activePrompts: number;
  guarding: boolean;
}

export interface AcpSessionManagerOptions {
  emit(frame: AcpServerFrame): void;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  lockDir?: string;
  bridgeDir?: string;
  launch?: (opts: AcpLaunchOptions) => Promise<AcpProcess>;
  isTerminalBusy?: typeof terminalOwnsSession;
  inspectOwner?: typeof inspectSessionOwner;
  idleMs?: number;
  tickMs?: number;
  takeoverTimeoutMs?: number;
  takeoverWaitTurnMs?: number;
  onAttention?(sessionKey: string): void;
  onSessionAvailable?(sessionKey: string): void;
}

/** One pool per authenticated server connection; no histories or tokens in SQL. */
export class AcpSessionManager {
  private sessions = new Map<string, WarmSession>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private opts: AcpSessionManagerOptions) {
    this.timer = setInterval(() => {
      void this.sweep();
    }, opts.tickMs ?? 1500);
    this.timer.unref();
  }

  private spectatingMessage(s: WarmSession): string {
    if (s.customMessage) return s.customMessage;
    if (s.takeoverPending) {
      return "已预约本轮结束后接管；终端当前轮次完成后将自动接管并按序送达消息";
    }
    const o = s.ownerInfo;
    if (o?.uncertain) {
      return o.reason || "检测到可能有未受控终端活动，消息已安全排队；关闭终端后自动送达";
    }
    if (o?.canTakeover) {
      return o.busy
        ? "终端正在执行当前轮次；网页可直接发消息排队，或点击「本轮结束后接管」"
        : "终端正打开此会话（当前空闲）；网页可直接发消息排队，或点击「由网页接管」";
    }
    return TERMINAL_MESSAGE;
  }

  private state(s: WarmSession, clientId?: string, requestId?: string): void {
    const canTakeover =
      s.status === "spectating" &&
      Boolean(s.ownerInfo?.canTakeover && !s.ownerInfo?.uncertain && s.ownerInfo?.ownerPid);
    this.opts.emit({
      type: "acp_session_state",
      sessionKey: s.sessionKey,
      sessionId: s.sessionId,
      adapterId: s.adapterId,
      epoch: s.epoch,
      status: s.status,
      readOnly: s.readOnly,
      ...(s.shared ? { shared: true } : {}),
      ...(s.status === "spectating"
        ? {
            canTakeover,
            terminalBusy: Boolean(s.ownerInfo?.busy),
            takeoverPending: s.takeoverPending,
            message: this.spectatingMessage(s),
          }
        : {}),
      modes: s.modes,
      targetClientId: clientId,
      requestId,
    });
  }

  private reset(s: WarmSession): void {
    clearTimeout(s.batchTimer);
    s.batchTimer = undefined;
    s.queue = [];
    s.ring.clear();
    s.epoch = randomUUID();
    this.opts.emit({ type: "acp_stream_event", sessionKey: s.sessionKey, epoch: s.epoch, reset: true, events: [] });
  }

  private queueUpdate(s: WarmSession, update: AcpUpdate): void {
    if (!this.sessions.has(s.sessionKey)) return;
    if (s.status === "busy" && update.sessionUpdate === "agent_message_chunk") {
      const c = update.content as { text?: string };
      s.turnBuffer += c?.text || "";
    }
    const previous = s.queue.at(-1);
    const content = update.content as { type?: string; text?: string } | undefined;
    const prevContent = previous?.content as { type?: string; text?: string } | undefined;
    if (
      previous &&
      previous.sessionUpdate === update.sessionUpdate &&
      update.messageId === previous.messageId &&
      /_chunk$/.test(update.sessionUpdate) &&
      content?.type === "text" &&
      prevContent?.type === "text" &&
      (prevContent.text?.length || 0) + (content.text?.length || 0) < 8000
    ) {
      prevContent.text = (prevContent.text || "") + (content.text || "");
    } else {
      s.queue.push(structuredClone(update));
    }
    if (s.queue.length >= 100) this.flush(s);
    if (!s.batchTimer) s.batchTimer = setTimeout(() => this.flush(s), 40);
  }

  private flush(s: WarmSession): void {
    clearTimeout(s.batchTimer);
    s.batchTimer = undefined;
    const updates = s.queue.splice(0);
    let events: AcpStreamItem[] = [];
    let bytes = 0;
    const emit = () => {
      if (events.length) {
        this.opts.emit({ type: "acp_stream_event", sessionKey: s.sessionKey, epoch: s.epoch, events });
      }
      events = [];
      bytes = 0;
    };
    for (const update of updates) {
      const json = JSON.stringify(update);
      // Preserve arbitrarily large tool outputs without exceeding the shared relay's frame limit.
      const chunks: AcpUpdate[] =
        Buffer.byteLength(json) < 24_000
          ? [update]
          : (() => {
              const data = json.match(/[\s\S]{1,6000}/g)!;
              const fragmentId = randomUUID();
              const total = data.length;
              return data.map((part, index) => ({
                sessionUpdate: "html_preview_fragment",
                fragmentId,
                index,
                total,
                data: part,
              }));
            })();
      for (const item of chunks) {
        const size = Buffer.byteLength(JSON.stringify(item)) + 150;
        if (bytes + size > 48_000) emit();
        const event = s.ring.append(item, s.phase);
        events.push(event);
        bytes += size;
      }
    }
    emit();
  }

  private collectOwnPids(): Set<number> {
    const pids = new Set<number>();
    for (const item of this.sessions.values()) {
      if (item.process?.pid) pids.add(item.process.pid);
      if (item.lockHandle?.pid) pids.add(item.lockHandle.pid);
    }
    return pids;
  }

  private currentStamp(s: WarmSession): string | undefined {
    if (!s.sessionId) return undefined;
    return statStamp(sessionFile(s.adapterId, s.sessionId, s.cwd, this.opts.homeDir ?? homedir(), this.opts.env));
  }

  private inspect(s: WarmSession): SessionOwnerInspection {
    if (s.readOnly || !s.sessionId) return { ownedByExternal: false };
    const own = this.collectOwnPids();
    const home = this.opts.homeDir ?? homedir();
    if (this.opts.isTerminalBusy) {
      const owned = this.opts.isTerminalBusy(s.adapterId, s.sessionId, s.cwd, own, home);
      return { ownedByExternal: owned, canTakeover: false };
    }
    return (this.opts.inspectOwner ?? inspectSessionOwner)(
      s.adapterId,
      s.sessionId,
      s.cwd,
      own,
      home,
      this.opts.env ?? process.env,
      this.opts.lockDir,
    );
  }

  private releaseLock(s: WarmSession): void {
    if (s.lockHandle) {
      s.lockHandle.release();
      s.lockHandle = undefined;
    }
  }

  private detachProcessOnly(s: WarmSession): void {
    s.process?.close();
    s.process = undefined;
    s.shared = false;
    this.releaseLock(s);
  }

  private permission(s: WarmSession, params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // Temporary questions never gain tools or mode privileges via the browser.
    if (s.readOnly) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const permissionId = randomUUID();
    return new Promise(resolve => {
      const p = {
        permissionId,
        toolCall: params.toolCall as Record<string, unknown>,
        options: params.options,
        resolve,
      };
      s.permissions.set(permissionId, p);
      this.sendPermission(s, p);
      this.opts.onAttention?.(s.sessionKey);
    });
  }

  private sendPermission(s: WarmSession, p: AcpPermission, clientId?: string): void {
    this.opts.emit({
      type: "acp_permission_request",
      sessionKey: s.sessionKey,
      epoch: s.epoch,
      permissionId: p.permissionId,
      toolCall: p.toolCall,
      options: p.options,
      targetClientId: clientId,
    });
  }

  respond(key: string, permissionId: string, outcome: RequestPermissionResponse["outcome"]): void {
    const s = this.sessions.get(key),
      p = s?.permissions.get(permissionId);
    if (!s || !p || s.readOnly) return;
    if (outcome.outcome === "selected" && !p.options.some(o => o.optionId === outcome.optionId)) {
      throw new Error("Unknown permission option");
    }
    s.permissions.delete(permissionId);
    p.resolve({ outcome });
    this.state(s);
  }

  has(key: string): boolean {
    return this.sessions.has(key);
  }

  getState(key: string): {
    readOnly: boolean;
    status: AcpSessionState["status"];
    shared: boolean;
    canTakeover: boolean;
    terminalBusy: boolean;
    takeoverPending: boolean;
    message?: string;
  } | undefined {
    const s = this.sessions.get(key);
    if (!s) return undefined;
    return {
      readOnly: s.readOnly,
      status: s.status,
      shared: s.shared,
      canTakeover: Boolean(
        s.status === "spectating" && s.ownerInfo?.canTakeover && !s.ownerInfo?.uncertain && s.ownerInfo?.ownerPid,
      ),
      terminalBusy: Boolean(s.ownerInfo?.busy),
      takeoverPending: s.takeoverPending,
      message: s.status === "spectating" ? this.spectatingMessage(s) : undefined,
    };
  }

  async open(input: OpenAcpSession): Promise<string> {
    let s =
      this.sessions.get(input.sessionKey) ||
      (input.sessionId
        ? [...this.sessions.values()].find(
            x => x.sessionId === input.sessionId && x.adapterId === input.adapterId && x.readOnly === input.readOnly,
          )
        : undefined);
    if (s?.status === "error" || s?.status === "closed") {
      await this.closeSession(s);
      s = undefined;
    }
    const cold = !s;
    if (s && (s.adapterId !== input.adapterId || s.readOnly !== input.readOnly)) {
      throw new Error("Session identity mismatch");
    }
    if (!s) {
      s = {
        ...input,
        epoch: randomUUID(),
        ring: new SessionRingBuffer(),
        status: "loading",
        phase: "replay",
        shared: false,
        takeoverPending: false,
        takingOver: false,
        queue: [],
        subscribers: new Map(),
        permissions: new Map(),
        lastUsed: Date.now(),
        turnBuffer: "",
        activePrompts: 0,
        guarding: false,
      };
      this.sessions.set(s.sessionKey, s);
      if (input.clientId) s.subscribers.set(input.clientId, Date.now());
      this.state(s, input.clientId, input.requestId);
      this.reset(s);
      s.ready = this.load(s).catch(error => {
        s!.status = "error";
        this.state(s!);
        throw error;
      });
      void s.ready.catch(() => {});
    } else if (input.clientId) {
      s.subscribers.set(input.clientId, Date.now());
    }
    await s.ready;
    s.lastUsed = Date.now();
    if (cold) {
      this.state(s, input.clientId, input.requestId);
    } else if (input.clientId) {
      this.state(s, input.clientId, input.requestId);
      await this.sync(s.sessionKey, input.afterSeq ?? 0, input.epoch, input.clientId, input.requestId);
    }
    return s.sessionKey;
  }

  private async load(s: WarmSession, forceStandalone = false): Promise<void> {
    const owner = this.inspect(s);
    s.ownerInfo = owner;
    if (owner.ownedByExternal || owner.uncertain) {
      this.spectate(s, owner);
      return;
    }

    const sharedEndpoint: SharedExecutorEndpoint | undefined =
      !s.readOnly && !forceStandalone ? owner.sharedEndpoint : undefined;

    if (
      !s.readOnly &&
      s.sessionId &&
      !sharedEndpoint &&
      (s.adapterId === "claude" || s.adapterId === "agy") &&
      !this.opts.isTerminalBusy
    ) {
      this.releaseLock(s);
      const lock = await acquireCooperativeSessionLock(this.opts.lockDir, s.adapterId, s.sessionId);
      if (!lock) {
        this.spectate(s, this.inspect(s));
        return;
      }
      s.lockHandle = lock;
    }

    if (s.readOnly && s.adapterId === "agy") {
      const dir = join(s.cwd, ".agents/agents");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(dir, "html-preview-readonly.md"),
        "---\nname: html-preview-readonly\ndescription: Read-only HTML questions\nenable_write_tools: false\ntools:\n  - read_file\n---\nAnswer from the HTML snapshot. Never modify files or execute commands.\n",
        { mode: 0o600 },
      );
    }

    let proc: AcpProcess;
    try {
      proc = await (this.opts.launch ?? startAcpProcess)({
        adapterId: s.adapterId,
        cwd: s.cwd,
        readOnly: s.readOnly,
        env: this.opts.env,
        sharedEndpoint,
        bridgeDir: this.opts.bridgeDir,
        onUpdate: u => this.queueUpdate(s, u),
        onPermission: p => this.permission(s, p),
        onExit: () => {
          s.process = undefined;
          s.shared = false;
          this.releaseLock(s);
          if (this.sessions.has(s.sessionKey) && s.status !== "spectating") {
            s.status = "error";
            this.state(s);
          }
        },
      });
    } catch (err) {
      this.releaseLock(s);
      if (sharedEndpoint && !forceStandalone) {
        const recheck = this.inspect(s);
        if (recheck.ownedByExternal || recheck.uncertain) {
          this.spectate(s, recheck);
          return;
        }
        return this.load(s, true);
      }
      throw err;
    }

    s.process = proc;
    s.shared = Boolean(sharedEndpoint);
    try {
      const params: Record<string, unknown> = { cwd: s.cwd, mcpServers: [] };
      if (s.readOnly && s.adapterId === "claude") {
        params._meta = {
          claudeCode: {
            options: {
              disallowedTools: [
                "Write",
                "Edit",
                "MultiEdit",
                "NotebookEdit",
                "Bash",
                "Task",
                "Agent",
                "Skill",
                "ToolSearch",
                "mcp__*",
              ],
            },
          },
        };
      }
      let result: Record<string, any>;
      if (s.sessionId) {
        if (!proc.capabilities.loadSession) throw new Error("ACP agent cannot replay session history");
        result = await proc.request("session/load", { ...params, sessionId: s.sessionId });
      } else {
        result = await proc.request("session/new", params);
        s.sessionId = result.sessionId;
      }
      if (!s.sessionId) throw new Error("ACP agent returned no session ID");
      if (
        !s.readOnly &&
        !s.lockHandle &&
        !s.shared &&
        (s.adapterId === "claude" || s.adapterId === "agy") &&
        !this.opts.isTerminalBusy
      ) {
        const lock = await acquireCooperativeSessionLock(this.opts.lockDir, s.adapterId, s.sessionId);
        if (lock) s.lockHandle = lock;
      }
      s.modes = result.modes;
      if (s.readOnly) {
        const modeId = s.adapterId === "codex" ? "read-only" : "plan";
        if (!s.modes?.availableModes.some(m => m.id === modeId)) {
          throw new Error("Agent does not offer the required read-only mode");
        }
        await proc.request("session/set_mode", { sessionId: s.sessionId, modeId });
        s.modes.currentModeId = modeId;
      }
      s.fileStamp = this.currentStamp(s);
      this.flush(s);
      s.phase = "live";
      s.status = "ready";
      this.state(s);
    } catch (error) {
      this.detachProcessOnly(s);
      const e = error as { message?: string; data?: { reason?: string } };
      if (
        e.data?.reason === "thread_active_writer" ||
        /thread_active_writer|active writer|already.*use/i.test(e.message || "")
      ) {
        this.reset(s);
        this.spectate(s, { ...owner, ownedByExternal: true });
        return;
      }
      if (sharedEndpoint && !forceStandalone) {
        // Shared endpoint rejected load (e.g. version mismatch on an external app-server holding the session)
        const file = s.sessionId
          ? sessionFile(s.adapterId, s.sessionId, s.cwd, this.opts.homeDir ?? homedir(), this.opts.env)
          : undefined;
        if (file) {
          this.reset(s);
          this.spectate(s, {
            ownedByExternal: true,
            canTakeover: false,
            reason: "共享服务版本或状态不兼容直接附着，已切换为实时旁观与安全排队",
          });
          return;
        }
      }
      throw error;
    }
  }

  private spectate(s: WarmSession, owner?: SessionOwnerInspection): void {
    this.detachProcessOnly(s);
    s.tail?.close();
    s.ownerInfo = owner ?? this.inspect(s);
    s.status = "spectating";
    const file = sessionFile(s.adapterId, s.sessionId!, s.cwd, this.opts.homeDir ?? homedir(), this.opts.env);
    if (!file) throw new Error("Cannot locate terminal session history");
    s.phase = "replay";
    s.tail = new SessionFileTail(
      file,
      row => transcriptUpdates(s.adapterId, row).forEach(u => this.queueUpdate(s, u)),
      () => this.reset(s),
    );
    s.tail.start();
    this.flush(s);
    s.phase = "live";
    this.state(s);
  }

  async sync(
    key: string,
    afterSeq: number,
    epoch: string | undefined,
    clientId: string,
    requestId?: string,
  ): Promise<void> {
    const s = this.sessions.get(key);
    if (!s) throw new Error("SESSION_COLD");
    await s.ready;
    s.subscribers.set(clientId, Date.now());
    s.lastUsed = Date.now();
    this.flush(s);
    const missing = s.ring.after(afterSeq);
    if (!missing || (epoch && epoch !== s.epoch)) {
      if (s.status === "busy") throw new Error("History changed; retry sync when this turn finishes");
      s.tail?.close();
      s.tail = undefined;
      this.detachProcessOnly(s);
      this.reset(s);
      s.status = "loading";
      s.phase = "replay";
      await this.load(s);
    } else {
      if (!epoch || afterSeq === 0) {
        this.opts.emit({
          type: "acp_stream_event",
          sessionKey: key,
          epoch: s.epoch,
          targetClientId: clientId,
          reset: true,
          events: [],
        });
      }
      for (let i = 0; i < missing.length; i++) {
        this.opts.emit({
          type: "acp_stream_event",
          sessionKey: key,
          epoch: s.epoch,
          targetClientId: clientId,
          events: [missing[i]],
        });
      }
    }
    this.state(s, clientId, requestId);
    for (const p of s.permissions.values()) this.sendPermission(s, p, clientId);
  }

  async prompt(key: string, text: string, abortSignal?: AbortSignal): Promise<{ replyText: string; sessionId: string }> {
    const s = this.sessions.get(key);
    if (!s) throw new Error("SESSION_COLD");
    await s.ready;

    if (!s.shared) {
      const owner = this.inspect(s);
      s.ownerInfo = owner;
      if (owner.ownedByExternal || owner.uncertain) {
        if (s.status !== "spectating") {
          this.reset(s);
          this.spectate(s, owner);
        }
        throw new Error(this.spectatingMessage(s));
      }
      if (s.status === "spectating") {
        await this.takeover(s);
      }
      // Agy's in-memory step_index in warm `agy acp` is NOT safe if disk changed externally:
      // recycle the ACP subprocess and cold `session/load` whenever the transcript changed!
      if (s.adapterId === "agy" && !s.readOnly && s.sessionId) {
        const current = this.currentStamp(s);
        if (current !== s.fileStamp) {
          this.detachProcessOnly(s);
          this.reset(s);
          s.phase = "replay";
          s.status = "loading";
          this.state(s);
          await this.load(s);
        }
      }
    }

    const canSend =
      Boolean(s.process && s.sessionId) &&
      (s.status === "ready" || (s.shared && s.status === "busy"));
    if (!canSend || !s.process || !s.sessionId) {
      throw new Error(s.status === "busy" ? "Session is already working" : "Session is unavailable; reopen it");
    }
    if (abortSignal?.aborted) throw new Error("Delivery aborted");

    if (s.activePrompts === 0) {
      s.turnBuffer = "";
    }
    s.activePrompts += 1;
    s.status = "busy";
    s.lastUsed = Date.now();
    this.state(s);
    this.queueUpdate(s, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
      messageId: randomUUID(),
    });

    const cancel = () => {
      void this.cancel(key);
    };
    abortSignal?.addEventListener("abort", cancel, { once: true });
    try {
      await s.process.request("session/prompt", {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text }],
      });
      const replyText = s.turnBuffer;
      s.turnBuffer = "";
      return { replyText, sessionId: s.sessionId };
    } finally {
      abortSignal?.removeEventListener("abort", cancel);
      s.activePrompts = Math.max(0, s.activePrompts - 1);
      s.fileStamp = this.currentStamp(s);
      s.lastUsed = Date.now();
      if (s.activePrompts === 0) {
        this.denyPending(s);
        this.queueUpdate(s, { sessionUpdate: "html_preview_turn_end" });
        this.flush(s);
        if (s.process) s.status = "ready";
        this.state(s);
      } else {
        this.flush(s);
      }
    }
  }

  async requestTakeover(key: string): Promise<{ status: AcpSessionState["status"]; message?: string }> {
    const s = this.sessions.get(key);
    if (!s) throw new Error("SESSION_COLD");
    await s.ready;
    if (s.readOnly || s.shared || s.status === "ready" || s.status === "busy") {
      this.state(s);
      if (s.status === "ready" || s.shared) this.opts.onSessionAvailable?.(s.sessionKey);
      return { status: s.status };
    }
    const owner = this.inspect(s);
    s.ownerInfo = owner;
    if (!owner.ownedByExternal && !owner.uncertain) {
      s.takeoverPending = false;
      s.customMessage = undefined;
      const nextStatus = await this.takeover(s);
      if (nextStatus === "ready" || s.shared) this.opts.onSessionAvailable?.(s.sessionKey);
      return { status: nextStatus };
    }
    if (owner.uncertain || !owner.canTakeover || !owner.ownerPid) {
      s.takeoverPending = false;
      s.customMessage = owner.reason || "无法精确确认单一终端进程归属，保持排队等待终端退出";
      this.state(s);
      return { status: s.status, message: s.customMessage };
    }
    if (owner.busy) {
      s.takeoverPending = true;
      s.takeoverDeadline = Date.now() + (this.opts.takeoverWaitTurnMs ?? 10 * 60_000);
      s.customMessage = undefined;
      this.state(s);
      return { status: s.status, message: this.spectatingMessage(s) };
    }
    await this.gentleInterruptAndTakeover(s, owner);
    return { status: s.status, message: s.status === "spectating" ? this.spectatingMessage(s) : undefined };
  }

  private async gentleInterruptAndTakeover(s: WarmSession, owner: SessionOwnerInspection): Promise<void> {
    if (s.takingOver || !owner.ownerPid) return;
    s.takingOver = true;
    try {
      const pid = owner.ownerPid;
      const own = this.collectOwnPids();
      if (!alive(pid) || own.has(pid)) {
        // Already exited or invalid
      } else {
        if (owner.ownerStartTime) {
          const currentStart = procStartTime(pid);
          if (currentStart && currentStart !== owner.ownerStartTime) {
            s.takeoverPending = false;
            s.customMessage = "终端进程身份已变化，取消信号发送并继续排队";
            this.state(s);
            return;
          }
        }
        try {
          process.kill(pid, "SIGINT");
        } catch {
          // Process may have exited right before kill
        }
      }

      const deadline = Date.now() + (this.opts.takeoverTimeoutMs ?? 4_000);
      while (Date.now() < deadline) {
        const cur = this.inspect(s);
        s.ownerInfo = cur;
        if (!cur.ownedByExternal && !cur.uncertain) {
          // Wait briefly for OS lock / FD / SQLite WAL settle
          const stamp1 = this.currentStamp(s);
          await sleep(80);
          if (this.currentStamp(s) !== stamp1) await sleep(80);
          s.takeoverPending = false;
          s.customMessage = undefined;
          await this.takeover(s);
          if (s.status === "ready" || s.shared) {
            this.opts.onSessionAvailable?.(s.sessionKey);
          }
          return;
        }
        await sleep(50);
      }

      // Gentle SIGINT timed out: never escalate to SIGTERM/SIGKILL; keep queued safely.
      s.takeoverPending = false;
      s.customMessage = "温和退出信号已发送但终端尚未释放会话，继续安全排队（未强制中断）";
      this.state(s);
    } finally {
      s.takingOver = false;
    }
  }

  /**
   * Releases an idle warm ACP session on demand so `html-preview session <claude|agy>`
   * can cleanly acquire the cooperative OS `flock` mutex without a stale warm writer.
   */
  async releaseForTerminal(
    adapterId: string,
    sessionId: string,
    waitMs = 5_000,
  ): Promise<{ released: boolean; status: string }> {
    const target = [...this.sessions.values()].find(
      s => !s.readOnly && s.adapterId === adapterId && s.sessionId === sessionId,
    );
    if (!target) return { released: true, status: "cold" };
    await target.ready?.catch(() => {});

    const deadline = Date.now() + waitMs;
    while (target.status === "busy" && Date.now() < deadline) {
      await sleep(50);
    }
    if (target.status === "busy") {
      return { released: false, status: "busy" };
    }
    if (target.subscribers.size === 0) {
      await this.closeSession(target);
      return { released: true, status: "closed" };
    }
    this.detachProcessOnly(target);
    return { released: true, status: "yielded" };
  }

  async cancel(key: string): Promise<void> {
    const s = this.sessions.get(key);
    if (!s || s.status === "spectating") return;
    this.denyPending(s);
    await s.process?.notify("session/cancel", { sessionId: s.sessionId });
  }

  async setMode(key: string, modeId: string): Promise<void> {
    const s = this.sessions.get(key);
    if (!s || s.readOnly || s.status !== "ready") throw new Error("Mode cannot be changed in this session");
    if (!s.shared) {
      const owner = this.inspect(s);
      if (owner.ownedByExternal || owner.uncertain) throw new Error("Mode cannot be changed in this session");
    }
    if (!s.modes?.availableModes.some(m => m.id === modeId)) throw new Error("Unknown mode");
    await s.process!.request("session/set_mode", { sessionId: s.sessionId, modeId });
    s.modes.currentModeId = modeId;
    this.state(s);
  }

  unsubscribe(key: string, clientId: string): void {
    this.sessions.get(key)?.subscribers.delete(clientId);
  }

  private denyPending(s: WarmSession): void {
    for (const p of s.permissions.values()) p.resolve({ outcome: { outcome: "cancelled" } });
    s.permissions.clear();
  }

  private async takeover(s: WarmSession): Promise<WarmSession["status"]> {
    s.tail?.close();
    s.tail = undefined;
    this.detachProcessOnly(s);
    this.reset(s);
    s.phase = "replay";
    s.status = "loading";
    this.state(s);
    await this.load(s);
    return s.status;
  }

  private async sweep(): Promise<void> {
    for (const s of this.sessions.values()) {
      const now = Date.now();
      for (const [clientId, seen] of s.subscribers) {
        if (now - seen > 75_000) s.subscribers.delete(clientId);
      }
      if (!s.subscribers.size && s.status !== "busy" && !s.takeoverPending && now - s.lastUsed >= (this.opts.idleMs ?? 15 * 60_000)) {
        await this.closeSession(s);
        continue;
      }
      if (s.status === "spectating") {
        s.tail?.read();
      }
      if (s.guarding || s.takingOver || s.status === "busy" || s.status === "loading" || s.readOnly) continue;
      s.guarding = true;
      try {
        const prevBusy = Boolean(s.ownerInfo?.busy);
        const prevCanTakeover = Boolean(s.ownerInfo?.canTakeover);
        const owner = this.inspect(s);
        s.ownerInfo = owner;
        const externallyOwned = Boolean(owner.ownedByExternal || owner.uncertain);

        if (s.status === "spectating") {
          if (!externallyOwned) {
            s.takeoverPending = false;
            s.customMessage = undefined;
            const nextStatus = await this.takeover(s);
            if (nextStatus === "ready" || s.shared) {
              this.opts.onSessionAvailable?.(s.sessionKey);
            }
          } else if (s.takeoverPending) {
            if (!owner.busy && owner.canTakeover && owner.ownerPid) {
              await this.gentleInterruptAndTakeover(s, owner);
            } else if (s.takeoverDeadline && now > s.takeoverDeadline) {
              s.takeoverPending = false;
              s.customMessage = "等待终端本轮结束超时，继续安全排队（未强制中断）";
              this.state(s);
            }
          } else if (prevBusy !== Boolean(owner.busy) || prevCanTakeover !== Boolean(owner.canTakeover)) {
            this.state(s);
          }
        } else if (externallyOwned && !s.shared) {
          this.reset(s);
          this.spectate(s, owner);
        }
      } catch {
        s.status = "error";
        this.state(s);
      } finally {
        s.guarding = false;
      }
    }
  }

  private async closeSession(s: WarmSession): Promise<void> {
    this.sessions.delete(s.sessionKey);
    clearTimeout(s.batchTimer);
    s.tail?.close();
    this.denyPending(s);
    // CRITICAL: Never send `session/close` to a shared executor (Grok leader cancels the terminal's active turn!).
    if (!s.shared && s.process?.capabilities.sessionCapabilities?.close && s.sessionId) {
      await Promise.race([
        s.process.request("session/close", { sessionId: s.sessionId }).catch(() => {}),
        sleep(1_000),
      ]);
    }
    this.detachProcessOnly(s);
    s.status = "closed";
    this.state(s);
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all([...this.sessions.values()].map(s => this.closeSession(s)));
  }
}
