import { buildAnchorPrompt } from "../prompt";
import { startAcpProcess } from "../acp-process";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type {
  AgentSessionSummary,
  ArtifactSourceLocation,
  CodingAgentAdapter,
  CodingAgentReply,
  CodingAgentSendContext,
  InteractionEnvelope,
  SessionBinding,
} from "../../interact-types";
import { encodeOpaqueBinding } from "../opaque-binding";

const UUID_LIKE_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type AcpExecutor = (params: {
  agentId: string;
  binding: SessionBinding;
  envelope: InteractionEnvelope;
  envelopePath: string;
  promptText: string;
  source: ArtifactSourceLocation;
  abortSignal?: AbortSignal;
}) => Promise<{
  replyText: string;
  sessionRef?: string;
  newVersion?: number;
  rawReceipt?: Record<string, unknown>;
}>;

export interface CodingAgentAdapterOptions {
  binary?: string;
  executor?: AcpExecutor;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildStructuredPrompt(
  envelope: InteractionEnvelope,
  envelopePath: string,
): string {
  const handoffFrom =
    typeof envelope.binding.adapterMeta?.handoffFromHostName === "string"
      ? envelope.binding.adapterMeta.handoffFromHostName
      : typeof envelope.binding.adapterMeta?.handoffFromHostId === "string"
        ? envelope.binding.adapterMeta.handoffFromHostId
        : null;

  const lines: string[] = [
    `# HTML Preview Interaction (${envelope.interactionId})`,
    "",
    `- Document: ${envelope.document.title} (\`${envelope.document.name}\`, base v${envelope.document.baseVersion})`,
    `- Preview URL: ${envelope.document.versionUrl}`,
    `- Intent: ${envelope.intent === "change" ? "message to original author session" : "question (answer in thread)"}`,
    `- Envelope JSON: \`${envelopePath}\``,
  ];
  if (handoffFrom) {
    lines.push(
      `- Cross-Host Handoff: Transferred from offline host \`${handoffFrom}\`; working from latest uploaded HTML snapshot.`,
    );
  }
  if (envelope.binding.sourceFile) {
    lines.push(`- Source File: \`${envelope.binding.sourceFile}\``);
  }
  if (envelope.anchor) {
    lines.push("", "## Selected Anchor", `- Entry: \`${envelope.anchor.entryPath}\``);
    if (envelope.anchor.elementSelector) {
      lines.push(`- Selector: \`${envelope.anchor.elementSelector}\``);
    }
    lines.push(`- Quote: ${JSON.stringify(envelope.anchor.exact)}`);
  }
  if (envelope.previousTurns && envelope.previousTurns.length > 0) {
    lines.push("", "## Previous Thread Turns");
    for (const turn of envelope.previousTurns) {
      lines.push(`- Turn #${turn.turnIndex} Owner: ${turn.prompt}`);
      if (turn.replyText) {
        lines.push(`  Agent: ${turn.replyText}`);
      }
      if (turn.resultVersion) {
        lines.push(`  Result Version: v${turn.resultVersion}`);
      }
    }
  }
  lines.push(
    "",
    "## Owner Request",
    buildAnchorPrompt(envelope.ownerPrompt, envelope.anchor, { documentId: envelope.document.id, version: envelope.document.baseVersion }),
    "",
    "## Response Instructions",
    envelope.intent === "question"
      ? "Answer from index.html in this isolated HTML snapshot. This is a read-only temporary session; do not modify any files."
      : `If the owner is asking a question, answer concisely. If requesting changes to the page, update the HTML deliverable, re-upload with \`html-preview upload <path> --name ${envelope.document.name} --resolves ${envelope.interactionId}\` (note: \`HTML_PREVIEW_INTERACTION_ID\` is also pre-set in your environment), and summarize your changes clearly. If the owner confirms engineering implementation or asks to delegate to another coding agent, carry out the implementation directly in this workspace or invoke your subagent/coding-agent skill as requested, then report back clearly.`,
  );
  return lines.join("\n");
}

function buildDemoUpdatedHtml(envelope: InteractionEnvelope): string {
  const title = escapeHtml(envelope.document.title || envelope.document.name);
  const anchorText = envelope.anchor?.exact ? escapeHtml(envelope.anchor.exact) : "";
  const promptText = escapeHtml(envelope.ownerPrompt);
  const nextVersionHint = envelope.document.baseVersion + 1;
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${title}</title>`,
    "  <style>",
    "    body { font-family: system-ui, -apple-system, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 20px; color: #0f172a; line-height: 1.6; }",
    "    .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #dcfce7; color: #166534; font-size: 13px; font-weight: 600; }",
    "    .card { margin: 20px 0 0; padding: 18px 20px; border: 1px solid #cbd5e1; border-radius: 12px; background: #f8fafc; }",
    "    blockquote { margin: 8px 0 0; padding-left: 12px; border-left: 3px solid #64748b; color: #475569; }",
    "  </style>",
    "</head>",
    "<body>",
    `  <span class="badge">Updated (v${nextVersionHint}+)</span>`,
    `  <h1>${title}</h1>`,
    '  <div class="card">',
    `    <p><strong>已应用的修订请求：</strong>${promptText}</p>`,
    anchorText ? `    <blockquote>定位原文：${anchorText}</blockquote>` : "",
    "  </div>",
    "</body>",
    "</html>",
  ]
    .filter(Boolean)
    .join("\n");
}

function readHeadUtf8(filePath: string, maxBytes = 8192): string {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const read = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, read).toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore
      }
    }
  }
}

export function spawnCommandAsync(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    abortSignal?: AbortSignal;
  },
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  aborted?: boolean;
  errorMessage?: string;
}> {
  return new Promise(resolve => {
    if (options.abortSignal?.aborted) {
      resolve({
        code: 130,
        stdout: "",
        stderr: "",
        aborted: true,
        errorMessage: "Delivery aborted before spawn",
      });
      return;
    }

    let settled = false;
    let aborted = false;
    let timedOut = false;
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const maxBytes = 10 * 1024 * 1024;
    let totalBytes = 0;

    let child;
    try {
      child = spawn(file, args, {
        shell: false,
        cwd: options.cwd || undefined,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        code: 1,
        stdout: "",
        stderr: "",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const killChild = () => {
      try {
        child.kill("SIGTERM");
        const killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore
          }
        }, 1500);
        killTimer.unref?.();
      } catch {
        // Ignore
      }
    };

    const onAbort = () => {
      aborted = true;
      killChild();
    };
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, options.timeoutMs);
    timeoutTimer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (totalBytes < maxBytes) {
        outChunks.push(chunk);
        totalBytes += chunk.length;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (totalBytes < maxBytes) {
        errChunks.push(chunk);
        totalBytes += chunk.length;
      }
    });

    const finish = (code: number, errMsg?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      options.abortSignal?.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(outChunks).toString("utf-8");
      const stderr = Buffer.concat(errChunks).toString("utf-8");
      resolve({
        code,
        stdout,
        stderr,
        aborted,
        errorMessage:
          errMsg ||
          (aborted
            ? "Delivery aborted (lease superseded or daemon stopping)"
            : timedOut
              ? `${file} timed out after ${options.timeoutMs}ms`
              : code !== 0
                ? stderr.trim() || `${file} exited with code ${code}`
                : undefined),
      });
    };

    child.on("error", err => {
      finish(1, err.message);
    });
    child.on("close", exitCode => {
      finish(typeof exitCode === "number" ? exitCode : aborted || timedOut ? 130 : 1);
    });
  });
}

async function resolveArtifactSourceLocation(
  envelope: InteractionEnvelope,
): Promise<ArtifactSourceLocation> {
  const meta = envelope.binding.adapterMeta ?? {};
  if (envelope.binding.cwd || !meta.handoffFromHostId) {
    return {
      cwd: envelope.binding.cwd ?? null,
      sourceFile: envelope.binding.sourceFile ?? null,
    };
  }
  const serverToken =
    typeof meta.daemonServerToken === "string"
      ? meta.daemonServerToken
      : typeof meta.demoToken === "string"
        ? meta.demoToken
        : undefined;
  const handoffRootDir =
    typeof meta.daemonHandoffDir === "string" ? meta.daemonHandoffDir : undefined;

  try {
    const safeName = (envelope.document.name || envelope.document.id).replace(
      /[^A-Za-z0-9_.-]/g,
      "_",
    );
    const baseDir = join(handoffRootDir || join(tmpdir(), "hp-handoff"), safeName);
    mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    const headers: Record<string, string> = {};
    if (serverToken) headers.Authorization = `Bearer ${serverToken}`;
    const resp = await fetch(envelope.document.versionUrl, { headers });
    if (!resp.ok) {
      return { cwd: null, sourceFile: null };
    }
    const html = await resp.text();
    const indexFile = join(baseDir, "index.html");
    writeFileSync(indexFile, html, { encoding: "utf-8", mode: 0o600 });
    return { cwd: baseDir, sourceFile: "index.html", handoffMaterialized: true };
  } catch {
    return { cwd: null, sourceFile: null };
  }
}

abstract class BaseCodingAgentAdapter implements CodingAgentAdapter {
  protected readonly homeDir: string;
  protected readonly baseEnv: NodeJS.ProcessEnv;

  constructor(
    public readonly id: string,
    public readonly displayName: string,
    protected readonly opts?: CodingAgentAdapterOptions,
  ) {
    this.homeDir = opts?.homeDir ?? homedir();
    this.baseEnv = opts?.env ?? process.env;
  }

  protected get binaryName(): string {
    return this.opts?.binary || this.id;
  }

  protected abstract checkAuthenticated(): Promise<{ ok: boolean; reason?: string }>;
  abstract listSessions(opts?: { cwd?: string; limit?: number }): Promise<AgentSessionSummary[]>;

  private probeCache?: { at: number; result: { available: boolean; version?: string; reason?: string } };
  async probe(): Promise<{ available: boolean; version?: string; reason?: string }> {
    if (this.probeCache && Date.now() - this.probeCache.at < 30_000) return this.probeCache.result;
    const result = await this.probeUncached();
    this.probeCache = { at: Date.now(), result };
    return result;
  }
  private async probeUncached(): Promise<{ available: boolean; version?: string; reason?: string }> {
    if (this.opts?.executor) {
      return { available: true, version: "custom-executor" };
    }
    const res = await spawnCommandAsync(this.binaryName, ["--version"], {
      timeoutMs: 3000,
      env: this.baseEnv,
    });
    if (res.code !== 0) {
      return {
        available: false,
        reason: res.errorMessage || res.stderr.trim() || `${this.binaryName} unavailable`,
      };
    }
    const version = (res.stdout || res.stderr).trim().split(/\r?\n/)[0] || undefined;
    const auth = await this.checkAuthenticated();
    if (!auth.ok) {
      return { available: false, version, reason: auth.reason || `${this.binaryName} unauthenticated` };
    }
    try {
      const acp = await startAcpProcess({ adapterId: this.id, cwd: tmpdir(), readOnly: false, env: this.baseEnv,
        onUpdate() {}, onPermission: async () => ({ outcome: { outcome: "cancelled" } }) });
      acp.close();
      return { available: true, version };
    } catch {
      return { available: false, version, reason: `${this.displayName} ACP v1 unavailable` };
    }
  }

  async locateArtifactSource(envelope: InteractionEnvelope): Promise<ArtifactSourceLocation> {
    return resolveArtifactSourceLocation(envelope);
  }

  async sendMessage(ctx: CodingAgentSendContext): Promise<CodingAgentReply> {
    const effectiveEnvelope: InteractionEnvelope =
      ctx.source.cwd || ctx.source.sourceFile
        ? {
            ...ctx.envelope,
            binding: {
              ...ctx.envelope.binding,
              cwd: ctx.source.cwd ?? ctx.envelope.binding.cwd,
              sourceFile: ctx.source.sourceFile ?? ctx.envelope.binding.sourceFile,
            },
          }
        : ctx.envelope;

    const rawRef = (effectiveEnvelope.binding.sessionRef || "").trim();
    const isAdhoc = !rawRef || rawRef === "adhoc" || rawRef === "auto";
    const promptText = buildStructuredPrompt(effectiveEnvelope, ctx.envelopePath);

    // 1. Injectable custom executor (unit/integration tests)
    if (this.opts?.executor) {
      await ctx.onWorking?.(`正在通过 ${this.displayName} 会话处理…`);
      const res = await this.opts.executor({
        agentId: this.id,
        binding: effectiveEnvelope.binding,
        envelope: effectiveEnvelope,
        envelopePath: ctx.envelopePath,
        promptText,
        source: ctx.source,
        abortSignal: ctx.abortSignal,
      });
      const discovered =
        res.sessionRef ||
        (typeof res.rawReceipt?.discoveredSessionRef === "string"
          ? res.rawReceipt.discoveredSessionRef
          : undefined);
      return {
        replyText: res.replyText,
        sessionRef: discovered || (isAdhoc ? undefined : rawRef),
        resumed: !isAdhoc,
        newVersion: res.newVersion,
        receipt: res.rawReceipt,
      };
    }

    const meta = effectiveEnvelope.binding.adapterMeta ?? {};
    const serverUrl =
      typeof meta.daemonServerUrl === "string"
        ? meta.daemonServerUrl
        : typeof meta.demoServerUrl === "string"
          ? meta.demoServerUrl
          : typeof meta.serverUrl === "string"
            ? meta.serverUrl
            : undefined;
    const serverToken =
      typeof meta.daemonServerToken === "string"
        ? meta.daemonServerToken
        : typeof meta.demoToken === "string"
          ? meta.demoToken
          : typeof meta.demoUploadToken === "string"
            ? meta.demoUploadToken
            : undefined;

    // 2. Deterministic local demoMode responder (used by `npm run demo:interact` & offline tests)
    if (meta.demoMode === true) {
      await ctx.onWorking?.(`正在通过 ${this.displayName} 会话处理…`);
      const resolvedRef = isAdhoc
        ? `demo-${this.id}-${effectiveEnvelope.threadId.slice(-8)}`
        : rawRef;

      if (
        effectiveEnvelope.intent === "change" &&
        typeof serverUrl === "string" &&
        serverUrl.length > 0 &&
        typeof serverToken === "string" &&
        serverToken.length > 0
      ) {
        const base = serverUrl.replace(/\/$/, "");
        const params = new URLSearchParams({
          name: effectiveEnvelope.document.name,
          note: `Updated for ${effectiveEnvelope.interactionId}`,
          resolves: effectiveEnvelope.interactionId,
        });
        if (effectiveEnvelope.binding.hostId) {
          params.set("host_id", effectiveEnvelope.binding.hostId);
          if (effectiveEnvelope.binding.hostName) {
            params.set("host_name", effectiveEnvelope.binding.hostName);
          }
        }
        params.set(
          "binding",
          encodeOpaqueBinding({
            agent: { adapter: this.id, ref: resolvedRef },
            cwd: effectiveEnvelope.binding.cwd,
            sourceFile: effectiveEnvelope.binding.sourceFile,
            demoMode: true,
          }),
        );
        const resp = await fetch(`${base}/upload?${params.toString()}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serverToken}`,
            "Content-Type": "text/html; charset=utf-8",
            Accept: "application/json",
          },
          body: buildDemoUpdatedHtml(effectiveEnvelope),
          signal: ctx.abortSignal,
        });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => "");
          throw new Error(`Demo HTML upload failed (HTTP ${resp.status}): ${errText.slice(0, 200)}`);
        }
        const uploaded = (await resp.json()) as { version?: number };
        const version =
          typeof uploaded.version === "number"
            ? uploaded.version
            : effectiveEnvelope.document.baseVersion + 1;
        return {
          replyText: `已完成修改并发布 v${version}（针对：${effectiveEnvelope.ownerPrompt.slice(0, 80)}）。`,
          sessionRef: resolvedRef,
          resumed: !isAdhoc,
          newVersion: version,
          receipt: { discoveredSessionRef: resolvedRef },
        };
      }

      const targetLabel = effectiveEnvelope.anchor?.exact || effectiveEnvelope.document.title;
      return {
        replyText: `[${this.displayName} 回复] 已针对「${targetLabel}」处理请求：${effectiveEnvelope.ownerPrompt}`,
        sessionRef: resolvedRef,
        resumed: !isAdhoc,
        receipt: { discoveredSessionRef: resolvedRef },
      };
    }

    if (!ctx.runAcp) throw new Error("ACP session client is required");
    return ctx.runAcp({
      adapterId: this.id, sessionRef: isAdhoc ? undefined : rawRef,
      cwd: effectiveEnvelope.binding.cwd || undefined,
      readOnly: effectiveEnvelope.intent === "question", promptText,
      contextKey: effectiveEnvelope.threadId,
    });
  }
}

export class ClaudeCodeAdapter extends BaseCodingAgentAdapter {
  constructor(opts?: CodingAgentAdapterOptions) {
    super("claude", "Claude Code", opts);
  }

  protected async checkAuthenticated(): Promise<{ ok: boolean; reason?: string }> {
    if (this.baseEnv.ANTHROPIC_API_KEY?.trim()) {
      return { ok: true };
    }
    const res = await spawnCommandAsync(this.binaryName, ["auth", "status"], {
      timeoutMs: 3000,
      env: this.baseEnv,
    });
    if (res.code === 0 && res.stdout.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(res.stdout.trim()) as { loggedIn?: boolean };
        if (parsed.loggedIn === true) return { ok: true };
        return { ok: false, reason: "Claude Code not logged in" };
      } catch {
        // Ignore non-JSON status output
      }
    }
    return { ok: false, reason: res.stderr.trim() || "Claude Code not logged in" };
  }

  async listSessions(opts?: { cwd?: string; limit?: number }): Promise<AgentSessionSummary[]> {
    const limit = Math.max(1, opts?.limit ?? 20);
    const rootDir = join(this.homeDir, ".claude", "projects");
    if (!existsSync(rootDir)) return [];

    const targetSlug = opts?.cwd ? opts.cwd.replace(/[^A-Za-z0-9]/g, "-") : null;
    const projectDirs = targetSlug
      ? [join(rootDir, targetSlug)]
      : readdirSync(rootDir).map(name => join(rootDir, name));

    const candidates: Array<{ sessionRef: string; filePath: string; mtimeMs: number }> = [];
    for (const projDir of projectDirs) {
      if (!existsSync(projDir)) continue;
      try {
        for (const entry of readdirSync(projDir)) {
          if (!entry.endsWith(".jsonl")) continue;
          const stem = entry.slice(0, -6);
          if (!UUID_LIKE_RE.test(stem)) continue;
          const filePath = join(projDir, entry);
          const st = statSync(filePath);
          candidates.push({ sessionRef: stem, filePath, mtimeMs: st.mtimeMs });
        }
      } catch {
        // Ignore unreadable directories
      }
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out: AgentSessionSummary[] = [];
    for (const item of candidates.slice(0, limit)) {
      let discoveredCwd: string | null = opts?.cwd ?? null;
      if (!discoveredCwd) {
        const head = readHeadUtf8(item.filePath, 8192);
        for (const line of head.split(/\r?\n/)) {
          if (!line.trim().startsWith("{")) continue;
          try {
            const obj = JSON.parse(line) as { cwd?: unknown };
            if (typeof obj.cwd === "string" && obj.cwd.trim()) {
              discoveredCwd = obj.cwd.trim();
              break;
            }
          } catch {
            // Ignore partial line
          }
        }
      }
      out.push({
        adapterId: this.id,
        sessionRef: item.sessionRef,
        cwd: discoveredCwd,
        updatedAt: new Date(item.mtimeMs).toISOString(),
      });
    }
    return out;
  }
}

export class CodexAdapter extends BaseCodingAgentAdapter {
  constructor(opts?: CodingAgentAdapterOptions) {
    super("codex", "Codex CLI", opts);
  }

  protected async checkAuthenticated(): Promise<{ ok: boolean; reason?: string }> {
    if (this.baseEnv.OPENAI_API_KEY?.trim()) {
      return { ok: true };
    }
    try {
      const auth = JSON.parse(readFileSync(join(this.baseEnv.CODEX_HOME || join(this.homeDir, ".codex"), "auth.json"), "utf-8"));
      if (auth.OPENAI_API_KEY || auth.tokens?.access_token || auth.tokens?.id_token) return { ok: true };
    } catch {}
    return { ok: false, reason: "Codex auth.json / OPENAI_API_KEY not found" };
  }

  async listSessions(opts?: { cwd?: string; limit?: number }): Promise<AgentSessionSummary[]> {
    const limit = Math.max(1, opts?.limit ?? 20);
    const rootDir = join(this.homeDir, ".codex", "sessions");
    if (!existsSync(rootDir)) return [];

    const files: Array<{ filePath: string; mtimeMs: number }> = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 4) return;
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const full = join(dir, name);
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            walk(full, depth + 1);
          } else if (name.endsWith(".jsonl")) {
            files.push({ filePath: full, mtimeMs: st.mtimeMs });
          }
        } catch {
          // Ignore
        }
      }
    };
    walk(rootDir, 0);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const out: AgentSessionSummary[] = [];
    for (const item of files) {
      if (out.length >= limit) break;
      const head = readHeadUtf8(item.filePath, 8192);
      const firstLine = head.split(/\r?\n/)[0]?.trim() || "";
      let sessionRef = "";
      let sessionCwd: string | null = null;
      if (firstLine.startsWith("{")) {
        try {
          const obj = JSON.parse(firstLine) as {
            payload?: { id?: unknown; session_id?: unknown; cwd?: unknown };
          };
          const id = obj.payload?.id ?? obj.payload?.session_id;
          if (typeof id === "string" && id.trim()) sessionRef = id.trim();
          if (typeof obj.payload?.cwd === "string" && obj.payload.cwd.trim()) {
            sessionCwd = obj.payload.cwd.trim();
          }
        } catch {
          // Fallback to filename UUID suffix
        }
      }
      if (!sessionRef) {
        const m = basename(item.filePath, ".jsonl").match(
          /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
        );
        if (m) sessionRef = m[1];
      }
      if (!sessionRef) continue;
      if (opts?.cwd && sessionCwd !== opts.cwd) continue;
      out.push({
        adapterId: this.id,
        sessionRef,
        cwd: sessionCwd,
        updatedAt: new Date(item.mtimeMs).toISOString(),
      });
    }
    return out;
  }
}

export class AgyAdapter extends BaseCodingAgentAdapter {
  constructor(opts?: CodingAgentAdapterOptions) {
    super("agy", "Antigravity CLI", opts);
  }

  protected async checkAuthenticated(): Promise<{ ok: boolean; reason?: string }> {
    if (this.baseEnv.GEMINI_API_KEY?.trim() || this.baseEnv.GOOGLE_API_KEY?.trim()) {
      return { ok: true };
    }
    try {
      const auth = JSON.parse(readFileSync(join(this.homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "utf-8"));
      if (auth.token && (typeof auth.token === "string" || auth.token.access_token || auth.token.refresh_token)) return { ok: true };
    } catch {}
    return { ok: false, reason: "Antigravity CLI OAuth token not found" };
  }

  async listSessions(opts?: { cwd?: string; limit?: number }): Promise<AgentSessionSummary[]> {
    const limit = Math.max(1, opts?.limit ?? 20);
    const brainDir = join(this.homeDir, ".gemini", "antigravity-cli", "brain");
    if (!existsSync(brainDir)) return [];

    const candidates: Array<{ sessionRef: string; mtimeMs: number }> = [];
    try {
      for (const name of readdirSync(brainDir)) {
        if (!UUID_LIKE_RE.test(name)) continue;
        const transcript = join(brainDir, name, ".system_generated", "logs", "transcript.jsonl");
        if (!existsSync(transcript)) continue;
        const st = statSync(transcript);
        candidates.push({ sessionRef: name, mtimeMs: st.mtimeMs });
      }
    } catch {
      return [];
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates.slice(0, limit).map(c => ({
      adapterId: this.id,
      sessionRef: c.sessionRef,
      cwd: null,
      updatedAt: new Date(c.mtimeMs).toISOString(),
    }));
  }
}


export class GrokAdapter extends BaseCodingAgentAdapter {
  constructor(opts?: CodingAgentAdapterOptions) { super("grok", "Grok Build", opts); }
  protected async checkAuthenticated(): Promise<{ ok: boolean; reason?: string }> {
    if (this.baseEnv.XAI_API_KEY || this.baseEnv.GROK_API_KEY) return { ok: true };
    try {
      const grokDir = this.baseEnv.GROK_HOME || join(this.homeDir, ".grok");
      const auth = JSON.parse(readFileSync(join(grokDir, "auth.json"), "utf-8"));
      if (Object.values(auth).some(v => typeof v === "string" && v.length > 0 || v && typeof v === "object" && Object.keys(v).length)) return { ok: true };
    } catch {}
    return { ok: false, reason: "Grok Build not logged in" };
  }
  async listSessions(opts?: { cwd?: string; limit?: number }): Promise<AgentSessionSummary[]> {
    const limit = Math.max(1, opts?.limit ?? 20);
    const grokDir = this.baseEnv.GROK_HOME || join(this.homeDir, ".grok");
    const sessionsRoot = join(grokDir, "sessions");
    if (!existsSync(sessionsRoot)) return [];
    const cwdDirs = opts?.cwd
      ? [{ dir: join(sessionsRoot, encodeURIComponent(opts.cwd)), cwd: opts.cwd }]
      : readdirSync(sessionsRoot).map(name => {
          let decoded: string | null = null;
          try { decoded = decodeURIComponent(name); } catch {}
          return { dir: join(sessionsRoot, name), cwd: decoded };
        });
    const candidates: Array<{ sessionRef: string; cwd: string | null; mtimeMs: number }> = [];
    for (const item of cwdDirs) {
      if (!existsSync(item.dir)) continue;
      try {
        for (const sid of readdirSync(item.dir)) {
          const updates = join(item.dir, sid, "updates.jsonl");
          if (!existsSync(updates)) continue;
          candidates.push({ sessionRef: sid, cwd: item.cwd, mtimeMs: statSync(updates).mtimeMs });
        }
      } catch {}
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates.slice(0, limit).map(c => ({
      adapterId: this.id,
      sessionRef: c.sessionRef,
      cwd: c.cwd,
      updatedAt: new Date(c.mtimeMs).toISOString(),
    }));
  }
}
