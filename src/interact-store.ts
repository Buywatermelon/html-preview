import { HttpError } from "./common";
import type { Document } from "./catalog";
import type { Database } from "./database";
import type {
  HostPresenceInfo,
  InteractionEnvelope,
  InteractionEventKind,
  InteractionIntent,
  InteractionRecord,
  InteractionStatus,
  InteractionStreamEvent,
  PushSubscriptionInput,
  PushSubscriptionRecord,
  SelectionAnchor,
  SessionBinding,
  SessionBindingInput,
} from "./interact-types";

const DISPLAY_TOKEN_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const HOST_ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const SESSION_REF_MAX = 256;
const PROMPT_MAX = 8000;
const REPLY_MAX = 64000;
const META_JSON_MAX = 4096;

interface BindingRow {
  id: string;
  owner_id: string;
  document_id: string;
  version: number;
  host_id?: string | null;
  host_name?: string | null;
  opaque_binding?: string | null;
  adapter_id: string;
  session_ref: string;
  cwd: string | null;
  source_file: string | null;
  adapter_meta_json: string;
  created_at: string;
}

interface InteractionRow {
  id: string;
  thread_id: string;
  turn_index: number;
  owner_id: string;
  document_id: string;
  base_version: number;
  request_id: string;
  anchor_json: string | null;
  intent: InteractionIntent;
  prompt: string;
  target_host_id?: string | null;
  target_host_name?: string | null;
  target_adapter_id: string;
  effective_adapter_id: string | null;
  status: InteractionStatus;
  progress_text: string | null;
  reply_text: string | null;
  result_version: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface DeliveryRow {
  id: string;
  interaction_id: string;
  owner_id: string;
  target_host_id?: string | null;
  adapter_id: string;
  attempt: number;
  state: string;
  lease_owner: string | null;
  lease_until: string | null;
  fencing_token: string | null;
  receipt_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  seq: number;
  owner_id: string;
  document_id: string;
  interaction_id: string;
  event_key: string;
  kind: InteractionEventKind;
  payload_json: string;
  created_at: string;
}

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseOpaquePayloadSafe(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("hpb1.")) {
    try {
      const b64 = trimmed.slice(5).replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      const bin = atob(padded);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const decoded = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(decoded);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return parseJsonSafe<Record<string, unknown>>(trimmed, {});
}

function sanitizeHostId(raw: unknown, field = "hostId"): string | null {
  if (raw == null || raw === "") return null;
  const val = typeof raw === "string" ? raw.trim() : "";
  if (!val) return null;
  if (!HOST_ID_RE.test(val)) {
    throw new HttpError(400, `Invalid ${field}`);
  }
  return val;
}

function sanitizeHostName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 80);
  return cleaned || null;
}

function sanitizeDisplayToken(raw: unknown, field = "label"): string {
  const val = typeof raw === "string" ? raw.trim() : "";
  if (!DISPLAY_TOKEN_RE.test(val)) {
    throw new HttpError(400, `${field} must match ${DISPLAY_TOKEN_RE.source}`);
  }
  return val;
}

function mapBinding(row: BindingRow): SessionBinding {
  return {
    id: row.id,
    documentId: row.document_id,
    version: row.version,
    hostId: row.host_id ?? null,
    hostName: row.host_name ?? null,
    opaqueBinding: row.opaque_binding ?? null,
    adapterId: row.adapter_id,
    sessionRef: row.session_ref,
    cwd: row.cwd,
    sourceFile: row.source_file,
    adapterMeta: parseJsonSafe<Record<string, unknown>>(row.adapter_meta_json, {}),
    createdAt: row.created_at,
  };
}

function mapInteraction(row: InteractionRow): InteractionRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    turnIndex: row.turn_index,
    documentId: row.document_id,
    baseVersion: row.base_version,
    requestId: row.request_id,
    anchor: parseJsonSafe<SelectionAnchor | null>(row.anchor_json, null),
    intent: row.intent,
    prompt: row.prompt,
    targetHostId: row.target_host_id ?? null,
    targetHostName: row.target_host_name ?? null,
    targetAdapterId: row.target_adapter_id,
    effectiveAdapterId: row.effective_adapter_id ?? null,
    status: row.status,
    progressText: row.progress_text,
    replyText: row.reply_text,
    resultVersion: row.result_version,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: EventRow): InteractionStreamEvent {
  const payload = parseJsonSafe<{
    summary?: string;
    replyText?: string | null;
    resultVersion?: number | null;
    status?: InteractionStatus;
    effectiveAdapterId?: string | null;
  }>(row.payload_json, {});
  return {
    seq: row.seq,
    documentId: row.document_id,
    interactionId: row.interaction_id,
    eventKey: row.event_key,
    kind: row.kind,
    summary: payload.summary,
    replyText: payload.replyText,
    resultVersion: payload.resultVersion,
    status: payload.status,
    effectiveAdapterId: payload.effectiveAdapterId ?? null,
    createdAt: row.created_at,
  };
}

function sanitizeAnchor(raw: unknown): SelectionAnchor | null {
  if (raw == null) return null;
  if (typeof raw !== "object") throw new HttpError(400, "Invalid anchor");
  const obj = raw as Record<string, unknown>;
  const exact = typeof obj.exact === "string" ? obj.exact.trim().slice(0, 2000) : "";
  if (!exact) return null;
  const entryPath =
    typeof obj.entryPath === "string" && obj.entryPath.trim()
      ? obj.entryPath.trim().slice(0, 240)
      : "index.html";
  const prefix = typeof obj.prefix === "string" ? obj.prefix.slice(0, 160) : undefined;
  const suffix = typeof obj.suffix === "string" ? obj.suffix.slice(0, 160) : undefined;
  const elementSelector =
    typeof obj.elementSelector === "string" ? obj.elementSelector.slice(0, 240) : undefined;
  return { entryPath, exact, prefix, suffix, elementSelector };
}

export class InteractStore {
  constructor(
    private db: Database,
    private base: string,
  ) {}

  async saveBinding(
    ownerId: string,
    documentId: string,
    version: number,
    input: SessionBindingInput,
  ): Promise<SessionBinding> {
    const hostId = sanitizeHostId(input.hostId, "hostId");
    const hostName = sanitizeHostName(input.hostName);

    let opaqueBinding: string | null = null;
    if (input.opaqueBinding != null && input.opaqueBinding !== "") {
      if (typeof input.opaqueBinding !== "string") {
        throw new HttpError(400, "opaqueBinding must be a string");
      }
      const trimmedOpaque = input.opaqueBinding.trim();
      if (trimmedOpaque.length > META_JSON_MAX) {
        throw new HttpError(400, "binding exceeds 4 KiB limit");
      }
      opaqueBinding = trimmedOpaque || null;
    }

    const hasDaemonOpaque = Boolean(hostId || opaqueBinding);
    const parsedOpaque = parseOpaquePayloadSafe(opaqueBinding);
    const agentObj =
      parsedOpaque.agent && typeof parsedOpaque.agent === "object" && !Array.isArray(parsedOpaque.agent)
        ? (parsedOpaque.agent as Record<string, unknown>)
        : parsedOpaque.fallback &&
            typeof parsedOpaque.fallback === "object" &&
            !Array.isArray(parsedOpaque.fallback)
          ? (parsedOpaque.fallback as Record<string, unknown>)
          : parsedOpaque.primary &&
              typeof parsedOpaque.primary === "object" &&
              !Array.isArray(parsedOpaque.primary)
            ? (parsedOpaque.primary as Record<string, unknown>)
            : null;
    const rawOpaqueAdapterRaw =
      agentObj && typeof agentObj.adapter === "string"
        ? agentObj.adapter.trim()
        : typeof parsedOpaque.kind === "string"
          ? parsedOpaque.kind.trim()
          : "";
    const rawOpaqueAdapter =
      rawOpaqueAdapterRaw === "claude" ||
      rawOpaqueAdapterRaw === "codex" ||
      rawOpaqueAdapterRaw === "agy" ||
      rawOpaqueAdapterRaw === "grok"
        ? rawOpaqueAdapterRaw
        : "";
    const derivedLabel = rawOpaqueAdapter
      ? sanitizeDisplayToken(rawOpaqueAdapter, "opaqueBinding.adapter")
      : "daemon";
    const adapterId = input.adapterId
      ? sanitizeDisplayToken(input.adapterId, "adapterId")
      : hasDaemonOpaque
        ? derivedLabel
        : (() => {
            throw new HttpError(400, "adapterId or hostId/binding is required");
          })();

    const rawSessionRef = typeof input.sessionRef === "string" ? input.sessionRef.trim() : "";
    const sessionRef = rawSessionRef || (hasDaemonOpaque ? "opaque" : "");
    if (!sessionRef || sessionRef.length > SESSION_REF_MAX || /[\x00-\x1f\x7f]/.test(sessionRef)) {
      throw new HttpError(400, "Invalid sessionRef");
    }

    const cwd =
      typeof input.cwd === "string" && input.cwd.trim()
        ? input.cwd.trim().slice(0, 512)
        : null;
    const sourceFile =
      typeof input.sourceFile === "string" && input.sourceFile.trim()
        ? input.sourceFile.trim().slice(0, 256)
        : null;
    const metaObj =
      input.adapterMeta && typeof input.adapterMeta === "object" && !Array.isArray(input.adapterMeta)
        ? input.adapterMeta
        : {};
    const metaJson = JSON.stringify(metaObj);
    if (metaJson.length > META_JSON_MAX) {
      throw new HttpError(400, "adapterMeta exceeds 4 KiB limit");
    }

    const id = `bind_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const now = new Date().toISOString();
    await this.db.batch([
      {
        sql: `INSERT INTO session_bindings(
                id, owner_id, document_id, version, host_id, host_name, opaque_binding,
                adapter_id, session_ref, cwd, source_file, adapter_meta_json, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(document_id, version) DO UPDATE SET
                host_id = COALESCE(excluded.host_id, session_bindings.host_id),
                host_name = COALESCE(excluded.host_name, session_bindings.host_name),
                opaque_binding = COALESCE(excluded.opaque_binding, session_bindings.opaque_binding),
                adapter_id = excluded.adapter_id,
                session_ref = excluded.session_ref,
                cwd = excluded.cwd,
                source_file = excluded.source_file,
                adapter_meta_json = excluded.adapter_meta_json`,
        values: [
          id,
          ownerId,
          documentId,
          version,
          hostId,
          hostName,
          opaqueBinding,
          adapterId,
          sessionRef,
          cwd,
          sourceFile,
          metaJson,
          now,
        ],
      },
    ]);
    const rows = await this.db.all<BindingRow>(
      "SELECT * FROM session_bindings WHERE owner_id = ? AND document_id = ? AND version = ?",
      [ownerId, documentId, version],
    );
    if (!rows[0]) throw new HttpError(500, "Failed to persist session binding");
    return mapBinding(rows[0]);
  }

  async listBindings(ownerId: string, documentId: string): Promise<SessionBinding[]> {
    const rows = await this.db.all<BindingRow>(
      "SELECT * FROM session_bindings WHERE owner_id = ? AND document_id = ? ORDER BY version DESC",
      [ownerId, documentId],
    );
    return rows.map(mapBinding);
  }

  async resolveBinding(
    ownerId: string,
    documentId: string,
    preferredVersion?: number,
  ): Promise<SessionBinding | null> {
    if (preferredVersion) {
      const exact = await this.db.all<BindingRow>(
        "SELECT * FROM session_bindings WHERE owner_id = ? AND document_id = ? AND version <= ? ORDER BY version DESC LIMIT 1",
        [ownerId, documentId, preferredVersion],
      );
      if (exact[0]) return mapBinding(exact[0]);
    }
    const latest = await this.db.all<BindingRow>(
      "SELECT * FROM session_bindings WHERE owner_id = ? AND document_id = ? ORDER BY version DESC LIMIT 1",
      [ownerId, documentId],
    );
    return latest[0] ? mapBinding(latest[0]) : null;
  }

  private async pickMostRecentlyActiveOnlineHost(
    ownerId: string,
    onlineHosts: HostPresenceInfo[],
  ): Promise<HostPresenceInfo | null> {
    if (onlineHosts.length === 0) return null;
    if (onlineHosts.length === 1) return onlineHosts[0]!;

    const byId = new Map(onlineHosts.map(h => [h.hostId, h]));

    // Check most recent upload binding or delivery activity for this owner
    const recentBindings = await this.db.all<{ host_id: string | null; created_at: string }>(
      "SELECT host_id, created_at FROM session_bindings WHERE owner_id = ? AND host_id IS NOT NULL ORDER BY created_at DESC LIMIT 10",
      [ownerId],
    );
    const recentDeliveries = await this.db.all<{ lease_owner: string | null; updated_at: string }>(
      "SELECT lease_owner, updated_at FROM interaction_deliveries WHERE owner_id = ? AND lease_owner IS NOT NULL ORDER BY updated_at DESC LIMIT 10",
      [ownerId],
    );

    let bestHost: HostPresenceInfo | null = null;
    let bestTs = "";
    for (const row of recentBindings) {
      if (row.host_id && byId.has(row.host_id) && row.created_at > bestTs) {
        bestTs = row.created_at;
        bestHost = byId.get(row.host_id)!;
      }
    }
    for (const row of recentDeliveries) {
      if (row.lease_owner && byId.has(row.lease_owner) && row.updated_at > bestTs) {
        bestTs = row.updated_at;
        bestHost = byId.get(row.lease_owner)!;
      }
    }
    if (bestHost) return bestHost;

    const sorted = [...onlineHosts].sort((a, b) =>
      (b.lastSeenAt || "").localeCompare(a.lastSeenAt || ""),
    );
    return sorted[0] ?? null;
  }

  async createInteraction(
    ownerId: string,
    doc: Document,
    latestVersion: number,
    input: {
      requestId?: string;
      threadId?: string;
      baseVersion?: number;
      anchor?: unknown;
      intent?: string;
      prompt?: string;
      targetAdapterId?: string;
    },
    onlineHosts: HostPresenceInfo[] = [],
  ): Promise<{
    interaction: InteractionRecord;
    event: InteractionStreamEvent;
    deduplicated: boolean;
  }> {
    const requestId =
      typeof input.requestId === "string" && input.requestId.trim()
        ? input.requestId.trim().slice(0, 80)
        : crypto.randomUUID();

    // Idempotent check for mobile weak-network retries
    const existing = await this.db.all<InteractionRow>(
      "SELECT * FROM interactions WHERE owner_id = ? AND request_id = ?",
      [ownerId, requestId],
    );
    if (existing[0] && existing[0].document_id === doc.id) {
      const evRows = await this.db.all<EventRow>(
        "SELECT * FROM interaction_events WHERE interaction_id = ? ORDER BY seq DESC LIMIT 1",
        [existing[0].id],
      );
      return {
        interaction: mapInteraction(existing[0]),
        event: evRows[0]
          ? mapEvent(evRows[0])
          : {
              seq: 0,
              documentId: doc.id,
              interactionId: existing[0].id,
              eventKey: "created",
              kind: "created",
              createdAt: existing[0].created_at,
            },
        deduplicated: true,
      };
    }

    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt || prompt.length > PROMPT_MAX) {
      throw new HttpError(400, `prompt is required and must be <= ${PROMPT_MAX} chars`);
    }
    const intent: InteractionIntent =
      input.intent === "question"
        ? "question"
        : input.intent === "change" || !input.intent
          ? "change"
          : (() => {
              throw new HttpError(400, "intent must be 'change' or 'question'");
            })();

    const baseVersion =
      typeof input.baseVersion === "number" && input.baseVersion >= 1
        ? Math.floor(input.baseVersion)
        : latestVersion;

    const binding = await this.resolveBinding(ownerId, doc.id, baseVersion);
    const targetAdapterId = input.targetAdapterId
      ? sanitizeDisplayToken(input.targetAdapterId, "targetAdapterId")
      : (intent === "question" ? "auto" : binding?.adapterId ?? "auto");

    const id = `int_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    let threadId = id;
    let turnIndex = 1;
    let anchor = sanitizeAnchor(input.anchor);
    let prevThreadHostId: string | null = null;
    let prevThreadHostName: string | null = null;

    if (typeof input.threadId === "string" && input.threadId.trim()) {
      const candidateThread = input.threadId.trim().slice(0, 64);
      const prevTurns = await this.db.all<InteractionRow>(
        "SELECT * FROM interactions WHERE owner_id = ? AND document_id = ? AND thread_id = ? ORDER BY turn_index DESC",
        [ownerId, doc.id, candidateThread],
      );
      if (prevTurns[0]) {
        threadId = candidateThread;
        turnIndex = prevTurns[0].turn_index + 1;
        prevThreadHostId = prevTurns[0].target_host_id ?? null;
        prevThreadHostName = prevTurns[0].target_host_name ?? null;
        if (!anchor && prevTurns.at(-1)?.anchor_json) {
          anchor = parseJsonSafe<SelectionAnchor | null>(prevTurns.at(-1)!.anchor_json, null);
        }
      }
    }

    // Multi-host routing matrix (PLAN.md §3.1):
    // 1. Bound page -> strictly route to origin hostId (even if offline/sleeping; never steal!)
    // 2. Thread continuation -> sticky to thread's hostId
    // 3. Unbound page -> pick most recently active online host, or NULL if 0 online
    let targetHostId: string | null = null;
    let targetHostName: string | null = null;
    if (binding?.hostId && (intent !== "question" || onlineHosts.some(h => h.hostId === binding.hostId))) {
      targetHostId = binding.hostId;
      targetHostName =
        onlineHosts.find(h => h.hostId === binding.hostId)?.hostName ||
        binding.hostName ||
        binding.hostId;
    } else if (prevThreadHostId && (intent !== "question" || onlineHosts.some(h => h.hostId === prevThreadHostId))) {
      targetHostId = prevThreadHostId;
      targetHostName =
        onlineHosts.find(h => h.hostId === prevThreadHostId)?.hostName ||
        prevThreadHostName ||
        prevThreadHostId;
    } else if (onlineHosts.length > 0) {
      const chosen = await this.pickMostRecentlyActiveOnlineHost(ownerId, onlineHosts);
      if (chosen) {
        targetHostId = chosen.hostId;
        targetHostName = chosen.hostName;
      }
    }

    const deliveryId = `dlv_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const now = new Date().toISOString();
    const targetOnline = targetHostId
      ? onlineHosts.some(h => h.hostId === targetHostId)
      : onlineHosts.length > 0;
    const summaryText = targetHostId
      ? targetOnline
        ? `已派发至 ${targetHostName || targetHostId} 队列`
        : `已加入队列，等待 ${targetHostName || targetHostId} 唤醒`
      : "批注已保存，等待守护进程认领";

    const eventPayload = JSON.stringify({
      status: "pending",
      summary: summaryText,
    });

    await this.db.batch([
      {
        sql: `INSERT INTO interactions(
                id, thread_id, turn_index, owner_id, document_id, base_version, request_id,
                anchor_json, intent, prompt, target_host_id, target_host_name, target_adapter_id, status,
                progress_text, reply_text, result_version, error_message, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, ?, ?)`,
        values: [
          id,
          threadId,
          turnIndex,
          ownerId,
          doc.id,
          baseVersion,
          requestId,
          anchor ? JSON.stringify(anchor) : null,
          intent,
          prompt,
          targetHostId,
          targetHostName,
          targetAdapterId,
          now,
          now,
        ],
      },
      {
        sql: `INSERT INTO interaction_deliveries(
                id, interaction_id, owner_id, target_host_id, adapter_id, attempt, state,
                lease_owner, lease_until, fencing_token, receipt_json, last_error, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, 0, 'pending', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        values: [deliveryId, id, ownerId, targetHostId, targetAdapterId, now, now],
      },
      {
        sql: `INSERT INTO interaction_events(
                owner_id, document_id, interaction_id, event_key, kind, payload_json, created_at
              ) VALUES (?, ?, ?, 'created', 'created', ?, ?)`,
        values: [ownerId, doc.id, id, eventPayload, now],
      },
    ]);

    const [created] = await this.db.all<InteractionRow>(
      "SELECT * FROM interactions WHERE id = ?",
      [id],
    );
    const [ev] = await this.db.all<EventRow>(
      "SELECT * FROM interaction_events WHERE interaction_id = ? AND event_key = 'created'",
      [id],
    );
    return {
      interaction: mapInteraction(created),
      event: mapEvent(ev),
      deduplicated: false,
    };
  }

  async listDocumentState(
    ownerId: string,
    documentId: string,
    afterSeq = 0,
  ): Promise<{
    bindings: SessionBinding[];
    interactions: InteractionRecord[];
    events: InteractionStreamEvent[];
    latestSeq: number;
  }> {
    const bindings = await this.listBindings(ownerId, documentId);
    const intRows = await this.db.all<InteractionRow>(
      "SELECT * FROM interactions WHERE owner_id = ? AND document_id = ? ORDER BY created_at ASC, turn_index ASC",
      [ownerId, documentId],
    );
    const evRows = await this.db.all<EventRow>(
      "SELECT * FROM interaction_events WHERE owner_id = ? AND document_id = ? AND seq > ? ORDER BY seq ASC LIMIT 500",
      [ownerId, documentId, Math.max(0, Math.floor(afterSeq))],
    );
    const maxSeqRows = await this.db.all<{ max_seq: number | null }>(
      "SELECT MAX(seq) AS max_seq FROM interaction_events WHERE owner_id = ? AND document_id = ?",
      [ownerId, documentId],
    );
    const latestSeq = maxSeqRows[0]?.max_seq ?? 0;
    return {
      bindings,
      interactions: intRows.map(mapInteraction),
      events: evRows.map(mapEvent),
      latestSeq,
    };
  }

  async claimPendingDeliveries(
    ownerId: string,
    input: {
      hostId?: string;
      hostName?: string;
      limit?: number;
      leaseSeconds?: number;
      includeDeferred?: boolean;
    },
  ): Promise<InteractionEnvelope[]> {
    const hostId = sanitizeHostId(input.hostId, "hostId");
    if (!hostId) {
      throw new HttpError(400, "hostId is required");
    }
    const hostName = sanitizeHostName(input.hostName);
    const limit = Math.min(10, Math.max(1, Math.floor(input.limit ?? 5)));
    const leaseSeconds = Math.min(300, Math.max(15, Math.floor(input.leaseSeconds ?? 90)));
    const includeDeferred = input.includeDeferred === true;
    const nowIso = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const pendingCond = includeDeferred
      ? "state = 'pending'"
      : "(state = 'pending' AND (lease_until IS NULL OR lease_until <= ?))";

    // Strict anti-job-stealing invariant (PLAN.md §3.2):
    // Only claim deliveries explicitly bound to this hostId or completely unbound (NULL).
    const sql = `SELECT * FROM interaction_deliveries
                 WHERE owner_id = ?
                   AND (${pendingCond} OR (state = 'leased' AND lease_until <= ?))
                   AND (target_host_id = ? OR target_host_id IS NULL)
                 ORDER BY CASE WHEN target_host_id = ? THEN 0 ELSE 1 END ASC, created_at ASC
                 LIMIT ?`;
    const values: Array<string | number> = includeDeferred
      ? [ownerId, nowIso, hostId, hostId, limit]
      : [ownerId, nowIso, nowIso, hostId, hostId, limit];

    const candidates = await this.db.all<DeliveryRow>(sql, values);
    const claimed: InteractionEnvelope[] = [];

    for (const cand of candidates) {
      const fencingToken = `fence_${crypto.randomUUID().replaceAll("-", "")}`;
      const nextAttempt = cand.attempt + 1;
      const eventKey = `leased:${nextAttempt}`;

      await this.db.batch([
        {
          sql: `UPDATE interaction_deliveries
                SET state = 'leased',
                    attempt = ?,
                    lease_owner = ?,
                    target_host_id = COALESCE(target_host_id, ?),
                    lease_until = ?,
                    fencing_token = ?,
                    updated_at = ?
                WHERE id = ?
                  AND owner_id = ?
                  AND attempt = ?
                  AND (target_host_id = ? OR target_host_id IS NULL)
                  AND (${pendingCond} OR (state = 'leased' AND lease_until <= ?))`,
          values: includeDeferred
            ? [
                nextAttempt,
                hostId,
                hostId,
                leaseUntil,
                fencingToken,
                nowIso,
                cand.id,
                ownerId,
                cand.attempt,
                hostId,
                nowIso,
              ]
            : [
                nextAttempt,
                hostId,
                hostId,
                leaseUntil,
                fencingToken,
                nowIso,
                cand.id,
                ownerId,
                cand.attempt,
                hostId,
                nowIso,
                nowIso,
              ],
        },
      ]);

      const verify = await this.db.all<DeliveryRow>(
        "SELECT * FROM interaction_deliveries WHERE id = ? AND fencing_token = ?",
        [cand.id, fencingToken],
      );
      if (!verify[0]) continue; // Another daemon won the CAS race

      const [intRow] = await this.db.all<InteractionRow>(
        "SELECT * FROM interactions WHERE id = ? AND owner_id = ?",
        [cand.interaction_id, ownerId],
      );
      if (!intRow) continue;

      const [docRow] = await this.db.all<Document>(
        "SELECT * FROM documents WHERE id = ? AND scope = ? AND deleting = 0",
        [intRow.document_id, ownerId],
      );
      if (!docRow) continue;

      const progressSummary = hostName ? `${hostName} 已认领任务…` : "守护进程已认领任务";
      await this.db.batch([
        {
          sql: `UPDATE interactions
                SET status = CASE WHEN status = 'pending' THEN 'leased' ELSE status END,
                    target_host_id = COALESCE(target_host_id, ?),
                    target_host_name = COALESCE(target_host_name, ?),
                    progress_text = ?,
                    updated_at = ?
                WHERE id = ?`,
          values: [hostId, hostName, progressSummary, nowIso, intRow.id],
        },
        {
          sql: `INSERT INTO interaction_events(
                  owner_id, document_id, interaction_id, event_key, kind, payload_json, created_at
                ) VALUES (?, ?, ?, ?, 'leased', ?, ?)
                ON CONFLICT(interaction_id, event_key) DO NOTHING`,
          values: [
            ownerId,
            docRow.id,
            intRow.id,
            eventKey,
            JSON.stringify({ status: "leased", summary: progressSummary }),
            nowIso,
          ],
        },
      ]);

      let binding = await this.resolveBinding(ownerId, docRow.id, intRow.base_version);
      const isCrossHostHandoff = Boolean(
        binding?.hostId && hostId && binding.hostId !== hostId,
      );

      if (!binding) {
        binding = {
          id: "bind_adhoc",
          documentId: docRow.id,
          version: intRow.base_version,
          hostId: hostId ?? null,
          hostName: hostName ?? null,
          opaqueBinding: null,
          adapterId: intRow.target_adapter_id,
          sessionRef: "adhoc",
          cwd: null,
          sourceFile: null,
          adapterMeta: {},
          createdAt: nowIso,
        };
      } else if (isCrossHostHandoff) {
        // Explicit user handoff from sleeping origin host to an online sibling host:
        // Do NOT reuse origin machine's local cwd or agent session ID; run a fresh session against online HTML!
        const parsedOriginOpaque = parseOpaquePayloadSafe(binding.opaqueBinding);
        const isDemoMode =
          binding.adapterMeta?.demoMode === true || parsedOriginOpaque.demoMode === true;
        binding = {
          id: `bind_handoff_${cand.id}`,
          documentId: docRow.id,
          version: intRow.base_version,
          hostId: hostId!,
          hostName: hostName ?? hostId!,
          opaqueBinding: null,
          adapterId: "auto",
          sessionRef: "adhoc",
          cwd: null,
          sourceFile: null,
          adapterMeta: {
            handoffFromHostId: binding.hostId,
            handoffFromHostName: binding.hostName,
            ...(isDemoMode ? { demoMode: true } : {}),
          },
          createdAt: nowIso,
        };
      }

      if (intRow.intent === "question") {
        // Questions always start an independent read-only session; never overwrite page bindings.
        binding = { ...binding, hostId: hostId ?? null, hostName: hostName ?? null,
          adapterId: intRow.target_adapter_id, sessionRef: "adhoc", opaqueBinding: null,
          cwd: null, sourceFile: null, adapterMeta: {} };
      }

      const prevTurnRows = await this.db.all<InteractionRow>(
        "SELECT * FROM interactions WHERE owner_id = ? AND thread_id = ? AND turn_index < ? ORDER BY turn_index ASC",
        [ownerId, intRow.thread_id, intRow.turn_index],
      );

      const docUrl = `${this.base}/p/${docRow.public_id}/`;
      claimed.push({
        interactionId: intRow.id,
        threadId: intRow.thread_id,
        turnIndex: intRow.turn_index,
        deliveryId: cand.id,
        attempt: nextAttempt,
        fencingToken,
        document: {
          id: docRow.id,
          publicId: docRow.public_id,
          name: docRow.name,
          title: docRow.title,
          baseVersion: intRow.base_version,
          versionUrl: `${docUrl}v${intRow.base_version}/`,
        },
        binding,
        anchor: parseJsonSafe<SelectionAnchor | null>(intRow.anchor_json, null),
        intent: intRow.intent,
        ownerPrompt: intRow.prompt,
        previousTurns: prevTurnRows.map(r => ({
          turnIndex: r.turn_index,
          prompt: r.prompt,
          replyText: r.reply_text,
          resultVersion: r.result_version,
        })),
        createdAt: intRow.created_at,
      });
    }

    return claimed;
  }

  async renewDeliveryLease(
    ownerId: string,
    input: {
      interactionId: string;
      fencingToken: string;
      leaseSeconds?: number;
    },
  ): Promise<{ ok: true; leaseUntil: string }> {
    const interactionId = (input.interactionId || "").trim();
    const fencingToken = (input.fencingToken || "").trim();
    if (!interactionId || !fencingToken) {
      throw new HttpError(400, "interactionId and fencingToken are required");
    }
    const leaseSeconds = Math.min(300, Math.max(15, Math.floor(input.leaseSeconds ?? 90)));
    const nowIso = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();

    const [dlv] = await this.db.all<DeliveryRow>(
      "SELECT * FROM interaction_deliveries WHERE interaction_id = ? AND owner_id = ?",
      [interactionId, ownerId],
    );
    if (!dlv) throw new HttpError(404, "Delivery not found");
    if (
      dlv.fencing_token !== fencingToken ||
      !["leased", "dispatched", "working"].includes(dlv.state)
    ) {
      throw new HttpError(409, "Stale or inactive fencingToken");
    }

    await this.db.batch([
      {
        sql: `UPDATE interaction_deliveries
              SET lease_until = ?, updated_at = ?
              WHERE id = ? AND owner_id = ? AND fencing_token = ?`,
        values: [leaseUntil, nowIso, dlv.id, ownerId, fencingToken],
      },
    ]);

    return { ok: true, leaseUntil };
  }

  async handoffInteraction(
    ownerId: string,
    interactionId: string,
    input: {
      targetHostId: string;
      targetHostName: string;
    },
  ): Promise<{ interaction: InteractionRecord; event: InteractionStreamEvent }> {
    const targetHostId = sanitizeHostId(input.targetHostId, "targetHostId");
    if (!targetHostId) {
      throw new HttpError(400, "targetHostId is required");
    }
    const targetHostName = sanitizeHostName(input.targetHostName) || targetHostId;

    const [intRow] = await this.db.all<InteractionRow>(
      "SELECT * FROM interactions WHERE id = ? AND owner_id = ?",
      [interactionId, ownerId],
    );
    if (!intRow) throw new HttpError(404, "Interaction not found");
    if (
      intRow.status === "replied" ||
      intRow.status === "updated" ||
      intRow.status === "resolved"
    ) {
      throw new HttpError(409, "Interaction has already completed");
    }

    const now = new Date().toISOString();
    const eventKey = `handoff:${targetHostId}:${crypto.randomUUID().slice(0, 10)}`;
    const summary = `已手动转交至在线机器 ${targetHostName}`;

    await this.db.batch([
      {
        sql: `UPDATE interactions
              SET target_host_id = ?,
                  target_host_name = ?,
                  status = 'pending',
                  progress_text = ?,
                  error_message = NULL,
                  updated_at = ?
              WHERE id = ? AND owner_id = ?`,
        values: [targetHostId, targetHostName, `${targetHostName} 准备接手处理…`, now, intRow.id, ownerId],
      },
      {
        sql: `UPDATE interaction_deliveries
              SET target_host_id = ?,
                  state = 'pending',
                  lease_owner = NULL,
                  lease_until = NULL,
                  fencing_token = NULL,
                  last_error = NULL,
                  updated_at = ?
              WHERE interaction_id = ? AND owner_id = ?`,
        values: [targetHostId, now, intRow.id, ownerId],
      },
      {
        sql: `INSERT INTO interaction_events(
                owner_id, document_id, interaction_id, event_key, kind, payload_json, created_at
              ) VALUES (?, ?, ?, ?, 'created', ?, ?)`,
        values: [
          ownerId,
          intRow.document_id,
          intRow.id,
          eventKey,
          JSON.stringify({ status: "pending", summary }),
          now,
        ],
      },
    ]);

    const [updated] = await this.db.all<InteractionRow>(
      "SELECT * FROM interactions WHERE id = ?",
      [intRow.id],
    );
    const [ev] = await this.db.all<EventRow>(
      "SELECT * FROM interaction_events WHERE interaction_id = ? AND event_key = ?",
      [intRow.id, eventKey],
    );
    return { interaction: mapInteraction(updated), event: mapEvent(ev) };
  }

  async reportDaemonEvent(
    ownerId: string,
    input: {
      interactionId: string;
      fencingToken: string;
      eventKey: string;
      kind:
        | "deferred"
        | "dispatched"
        | "working"
        | "replied"
        | "needs_attention"
        | "failed";
      deferSeconds?: number;
      summary?: string;
      replyText?: string;
      newVersion?: number;
      errorMessage?: string;
      displayAgent?: string;
      effectiveAdapterId?: string;
      discoveredBinding?: {
        hostId: string;
        hostName?: string;
        binding?: string;
        adapterId?: string;
        sessionRef?: string;
        version?: number;
      };
      receipt?: Record<string, unknown>;
    },
  ): Promise<{ interaction: InteractionRecord; event: InteractionStreamEvent; deduplicated: boolean }> {
    const [dlv] = await this.db.all<DeliveryRow>(
      "SELECT * FROM interaction_deliveries WHERE interaction_id = ? AND owner_id = ?",
      [input.interactionId, ownerId],
    );
    if (!dlv) throw new HttpError(404, "Delivery not found");
    if (!input.fencingToken || dlv.fencing_token !== input.fencingToken) {
      throw new HttpError(409, "Stale or invalid fencingToken");
    }

    const [intRow] = await this.db.all<InteractionRow>(
      "SELECT * FROM interactions WHERE id = ? AND owner_id = ?",
      [input.interactionId, ownerId],
    );
    if (!intRow) throw new HttpError(404, "Interaction not found");

    const eventKey = (input.eventKey || `${dlv.id}:${input.kind}`).trim().slice(0, 120);
    const existingEv = await this.db.all<EventRow>(
      "SELECT * FROM interaction_events WHERE interaction_id = ? AND event_key = ?",
      [intRow.id, eventKey],
    );
    if (existingEv[0]) {
      return {
        interaction: mapInteraction(intRow),
        event: mapEvent(existingEv[0]),
        deduplicated: true,
      };
    }

    const now = new Date().toISOString();
    const summary = input.summary ? input.summary.slice(0, 500) : undefined;
    const rawEffective = input.displayAgent || input.effectiveAdapterId;
    const nextEffectiveAdapter = rawEffective
      ? sanitizeDisplayToken(rawEffective, "effectiveAdapterId")
      : (intRow.effective_adapter_id ?? intRow.target_adapter_id);

    if (input.kind === "deferred") {
      const deferSec = Math.min(120, Math.max(2, Math.floor(input.deferSeconds ?? 15)));
      const deferUntil = new Date(Date.now() + deferSec * 1000).toISOString();
      const nextProgress = summary || "终端正在使用原会话，已排队等待释放";
      const payloadJson = JSON.stringify({
        status: "pending",
        summary: nextProgress,
        effectiveAdapterId: nextEffectiveAdapter,
      });
      await this.db.batch([
        {
          sql: `UPDATE interactions
                SET status = 'pending',
                    effective_adapter_id = ?,
                    progress_text = ?,
                    error_message = NULL,
                    updated_at = ?
                WHERE id = ? AND owner_id = ?`,
          values: [nextEffectiveAdapter, nextProgress, now, intRow.id, ownerId],
        },
        {
          sql: `UPDATE interaction_deliveries
                SET state = 'pending',
                    lease_owner = NULL,
                    lease_until = ?,
                    fencing_token = NULL,
                    receipt_json = COALESCE(?, receipt_json),
                    last_error = NULL,
                    updated_at = ?
                WHERE id = ? AND fencing_token = ?`,
          values: [
            deferUntil,
            input.receipt ? JSON.stringify(input.receipt) : null,
            now,
            dlv.id,
            input.fencingToken,
          ],
        },
        {
          sql: `INSERT INTO interaction_events(
                  owner_id, document_id, interaction_id, event_key, kind, payload_json, created_at
                ) VALUES (?, ?, ?, ?, 'created', ?, ?)`,
          values: [ownerId, intRow.document_id, intRow.id, eventKey, payloadJson, now],
        },
      ]);
      const [updated] = await this.db.all<InteractionRow>(
        "SELECT * FROM interactions WHERE id = ?",
        [intRow.id],
      );
      const [ev] = await this.db.all<EventRow>(
        "SELECT * FROM interaction_events WHERE interaction_id = ? AND event_key = ?",
        [intRow.id, eventKey],
      );
      return {
        interaction: mapInteraction(updated),
        event: mapEvent(ev),
        deduplicated: false,
      };
    }

    const replyText =
      typeof input.replyText === "string" && input.replyText.trim()
        ? input.replyText.trim().slice(0, REPLY_MAX)
        : null;
    const errorMessage =
      typeof input.errorMessage === "string" && input.errorMessage.trim()
        ? input.errorMessage.trim().slice(0, 1000)
        : null;
    const linkedVersion =
      typeof input.newVersion === "number" && input.newVersion >= 1
        ? Math.floor(input.newVersion)
        : intRow.result_version;

    // Preserve `updated` status if a new HTML version was already uploaded & linked during this turn!
    let nextStatus: InteractionStatus = input.kind;
    if (linkedVersion && input.kind === "replied") {
      nextStatus = "updated";
    }

    const nextReply = replyText ?? intRow.reply_text;
    const nextProgress =
      input.kind === "working" || input.kind === "dispatched"
        ? summary || (input.kind === "working" ? "Agent 正在处理…" : "已派发至会话")
        : null;

    const dlvState = input.kind;

    const payloadJson = JSON.stringify({
      status: nextStatus,
      summary,
      replyText: nextReply,
      resultVersion: linkedVersion,
      effectiveAdapterId: nextEffectiveAdapter,
    });

    await this.db.batch([
      {
        sql: `UPDATE interactions
              SET status = ?,
                  effective_adapter_id = ?,
                  progress_text = ?,
                  reply_text = ?,
                  result_version = ?,
                  error_message = ?,
                  updated_at = ?
              WHERE id = ? AND owner_id = ?`,
        values: [
          nextStatus,
          nextEffectiveAdapter,
          nextProgress,
          nextReply,
          linkedVersion,
          errorMessage,
          now,
          intRow.id,
          ownerId,
        ],
      },
      {
        sql: `UPDATE interaction_deliveries
              SET state = ?,
                  receipt_json = COALESCE(?, receipt_json),
                  last_error = ?,
                  updated_at = ?
              WHERE id = ? AND fencing_token = ?`,
        values: [
          dlvState,
          input.receipt ? JSON.stringify(input.receipt) : null,
          errorMessage,
          now,
          dlv.id,
          input.fencingToken,
        ],
      },
      {
        sql: `INSERT INTO interaction_events(
                owner_id, document_id, interaction_id, event_key, kind, payload_json, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        values: [ownerId, intRow.document_id, intRow.id, eventKey, input.kind, payloadJson, now],
      },
    ]);

    // Atomically persist discovered session/host binding when unbound page gets its first reply!
    if (input.discoveredBinding?.hostId) {
      const targetBindVersion =
        input.discoveredBinding.version ?? linkedVersion ?? intRow.base_version;
      await this.saveBinding(ownerId, intRow.document_id, targetBindVersion, {
        hostId: input.discoveredBinding.hostId,
        hostName: input.discoveredBinding.hostName,
        opaqueBinding: input.discoveredBinding.binding,
        adapterId: input.discoveredBinding.adapterId,
        sessionRef: input.discoveredBinding.sessionRef,
      }).catch(() => {});
    }

    const [updated] = await this.db.all<InteractionRow>(
      "SELECT * FROM interactions WHERE id = ?",
      [intRow.id],
    );
    const [ev] = await this.db.all<EventRow>(
      "SELECT * FROM interaction_events WHERE interaction_id = ? AND event_key = ?",
      [intRow.id, eventKey],
    );
    return {
      interaction: mapInteraction(updated),
      event: mapEvent(ev),
      deduplicated: false,
    };
  }

  /**
   * Explicit callback endpoint used by:
   * 1. Coding agents calling `html-preview reply <interactionId> --text "..."`
   * 2. Owner clicking "解决 (resolve)" or "重试 (retry)" in desktop/mobile UI
   */
  async updateOrReplyInteraction(
    ownerId: string,
    interactionId: string,
    input: {
      action?: "reply" | "resolve" | "retry";
      replyText?: string;
      status?: "replied" | "needs_attention" | "resolved";
      targetAdapterId?: string;
      summary?: string;
    },
  ): Promise<{ interaction: InteractionRecord; event: InteractionStreamEvent }> {
    const [intRow] = await this.db.all<InteractionRow>(
      "SELECT * FROM interactions WHERE id = ? AND owner_id = ?",
      [interactionId, ownerId],
    );
    if (!intRow) throw new HttpError(404, "Interaction not found");

    const now = new Date().toISOString();
    const action = input.action || (input.status === "resolved" ? "resolve" : "reply");

    if (action === "retry") {
      const eventKey = `retry:${crypto.randomUUID().slice(0, 12)}`;
      await this.db.batch([
        {
          sql: `UPDATE interactions
                SET effective_adapter_id = NULL,
                    status = 'pending', progress_text = '已重新排队待派发',
                    error_message = NULL, updated_at = ?
                WHERE id = ? AND owner_id = ?`,
          values: [now, intRow.id, ownerId],
        },
        {
          sql: `UPDATE interaction_deliveries
                SET state = 'pending', lease_owner = NULL, lease_until = NULL,
                    fencing_token = NULL, last_error = NULL, updated_at = ?
                WHERE interaction_id = ? AND owner_id = ?`,
          values: [now, intRow.id, ownerId],
        },
        {
          sql: `INSERT INTO interaction_events(
                  owner_id, document_id, interaction_id, event_key, kind, payload_json, created_at
                ) VALUES (?, ?, ?, ?, 'created', ?, ?)`,
          values: [
            ownerId,
            intRow.document_id,
            intRow.id,
            eventKey,
            JSON.stringify({ status: "pending", summary: "已重新加入派发队列" }),
            now,
          ],
        },
      ]);
      const [updated] = await this.db.all<InteractionRow>(
        "SELECT * FROM interactions WHERE id = ?",
        [intRow.id],
      );
      const [ev] = await this.db.all<EventRow>(
        "SELECT * FROM interaction_events WHERE interaction_id = ? AND event_key = ?",
        [intRow.id, eventKey],
      );
      return { interaction: mapInteraction(updated), event: mapEvent(ev) };
    }

    if (action === "resolve") {
      const eventKey = `resolved:${crypto.randomUUID().slice(0, 12)}`;
      await this.db.batch([
        {
          sql: "UPDATE interactions SET status = 'resolved', progress_text = NULL, updated_at = ? WHERE id = ? AND owner_id = ?",
          values: [now, intRow.id, ownerId],
        },
        {
          sql: `INSERT INTO interaction_events(
                  owner_id, document_id, interaction_id, event_key, kind, payload_json, created_at
                ) VALUES (?, ?, ?, ?, 'resolved', ?, ?)`,
          values: [
            ownerId,
            intRow.document_id,
            intRow.id,
            eventKey,
            JSON.stringify({ status: "resolved", summary: "已标记解决" }),
            now,
          ],
        },
      ]);
      const [updated] = await this.db.all<InteractionRow>(
        "SELECT * FROM interactions WHERE id = ?",
        [intRow.id],
      );
      const [ev] = await this.db.all<EventRow>(
        "SELECT * FROM interaction_events WHERE interaction_id = ? AND event_key = ?",
        [intRow.id, eventKey],
      );
      return { interaction: mapInteraction(updated), event: mapEvent(ev) };
    }

    const replyText =
      typeof input.replyText === "string" ? input.replyText.trim().slice(0, REPLY_MAX) : "";
    if (!replyText && input.status !== "needs_attention") {
      throw new HttpError(400, "replyText is required");
    }
    const kind: InteractionEventKind =
      input.status === "needs_attention" ? "needs_attention" : "replied";
    const nextStatus: InteractionStatus =
      kind === "needs_attention"
        ? "needs_attention"
        : intRow.result_version
          ? "updated"
          : "replied";
    const eventKey = `callback:${kind}:${crypto.randomUUID().slice(0, 12)}`;

    await this.db.batch([
      {
        sql: `UPDATE interactions
              SET status = ?,
                  progress_text = NULL,
                  reply_text = COALESCE(?, reply_text),
                  error_message = ?,
                  updated_at = ?
              WHERE id = ? AND owner_id = ?`,
        values: [
          nextStatus,
          replyText || null,
          kind === "needs_attention" ? input.summary || replyText || "需要主人关注" : null,
          now,
          intRow.id,
          ownerId,
        ],
      },
      {
        sql: `UPDATE interaction_deliveries
              SET state = ?, updated_at = ?
              WHERE interaction_id = ? AND owner_id = ?`,
        values: [kind, now, intRow.id, ownerId],
      },
      {
        sql: `INSERT INTO interaction_events(
                owner_id, document_id, interaction_id, event_key, kind, payload_json, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        values: [
          ownerId,
          intRow.document_id,
          intRow.id,
          eventKey,
          kind,
          JSON.stringify({
            status: nextStatus,
            replyText: replyText || intRow.reply_text,
            resultVersion: intRow.result_version,
            summary: input.summary,
          }),
          now,
        ],
      },
    ]);

    const [updated] = await this.db.all<InteractionRow>(
      "SELECT * FROM interactions WHERE id = ?",
      [intRow.id],
    );
    const [ev] = await this.db.all<EventRow>(
      "SELECT * FROM interaction_events WHERE interaction_id = ? AND event_key = ?",
      [intRow.id, eventKey],
    );
    return { interaction: mapInteraction(updated), event: mapEvent(ev) };
  }

  async linkVersionToInteractions(
    ownerId: string,
    documentId: string,
    newVersion: number,
    interactionIds: string[],
    note?: string,
  ): Promise<Array<{ interaction: InteractionRecord; event: InteractionStreamEvent }>> {
    const uniqueIds = [...new Set(interactionIds.map(s => s.trim()).filter(Boolean))].slice(0, 20);
    const results: Array<{ interaction: InteractionRecord; event: InteractionStreamEvent }> = [];
    const now = new Date().toISOString();

    for (const id of uniqueIds) {
      const [intRow] = await this.db.all<InteractionRow>(
        "SELECT * FROM interactions WHERE id = ? AND owner_id = ? AND document_id = ?",
        [id, ownerId, documentId],
      );
      if (!intRow) continue;

      const eventKey = `version:${newVersion}`;
      await this.db.batch([
        {
          sql: `UPDATE interactions
                SET status = 'updated',
                    result_version = ?,
                    progress_text = NULL,
                    updated_at = ?
                WHERE id = ? AND owner_id = ?`,
          values: [newVersion, now, id, ownerId],
        },
        {
          sql: `INSERT INTO interaction_events(
                  owner_id, document_id, interaction_id, event_key, kind, payload_json, created_at
                ) VALUES (?, ?, ?, ?, 'version_linked', ?, ?)
                ON CONFLICT(interaction_id, event_key) DO NOTHING`,
          values: [
            ownerId,
            documentId,
            id,
            eventKey,
            JSON.stringify({
              status: "updated",
              resultVersion: newVersion,
              replyText: intRow.reply_text,
              summary: note ? `已更新至 v${newVersion}：${note}` : `已生成新版本 v${newVersion}`,
            }),
            now,
          ],
        },
      ]);

      const [updated] = await this.db.all<InteractionRow>(
        "SELECT * FROM interactions WHERE id = ?",
        [id],
      );
      const [ev] = await this.db.all<EventRow>(
        "SELECT * FROM interaction_events WHERE interaction_id = ? AND event_key = ?",
        [id, eventKey],
      );
      if (updated && ev) {
        results.push({ interaction: mapInteraction(updated), event: mapEvent(ev) });
      }
    }
    return results;
  }

  async savePushSubscription(
    ownerId: string,
    input: PushSubscriptionInput,
  ): Promise<PushSubscriptionRecord> {
    const endpoint = typeof input.endpoint === "string" ? input.endpoint.trim() : "";
    if (!/^https?:\/\/\S+$/i.test(endpoint) || endpoint.length > 1024) {
      throw new HttpError(400, "Invalid Web Push endpoint URL");
    }
    const p256dh = typeof input.keys?.p256dh === "string" ? input.keys.p256dh.trim() : "";
    const auth = typeof input.keys?.auth === "string" ? input.keys.auth.trim() : "";
    if (!p256dh || !auth || p256dh.length > 256 || auth.length > 128) {
      throw new HttpError(400, "Invalid Web Push encryption keys");
    }
    const userAgent =
      typeof input.userAgent === "string" ? input.userAgent.slice(0, 256) : null;
    const id = `push_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const now = new Date().toISOString();
    await this.db.batch([
      {
        sql: `INSERT INTO push_subscriptions(id, owner_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(owner_id, endpoint) DO UPDATE SET
                p256dh = excluded.p256dh,
                auth = excluded.auth,
                user_agent = excluded.user_agent,
                updated_at = excluded.updated_at`,
        values: [id, ownerId, endpoint, p256dh, auth, userAgent, now, now],
      },
    ]);
    const rows = await this.db.all<{
      id: string;
      owner_id: string;
      endpoint: string;
      p256dh: string;
      auth: string;
      user_agent: string | null;
      created_at: string;
      updated_at: string;
    }>("SELECT * FROM push_subscriptions WHERE owner_id = ? AND endpoint = ?", [
      ownerId,
      endpoint,
    ]);
    const r = rows[0]!;
    return {
      id: r.id,
      ownerId: r.owner_id,
      endpoint: r.endpoint,
      p256dh: r.p256dh,
      auth: r.auth,
      userAgent: r.user_agent,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async listPushSubscriptions(ownerId: string): Promise<PushSubscriptionRecord[]> {
    const rows = await this.db.all<{
      id: string;
      owner_id: string;
      endpoint: string;
      p256dh: string;
      auth: string;
      user_agent: string | null;
      created_at: string;
      updated_at: string;
    }>("SELECT * FROM push_subscriptions WHERE owner_id = ? ORDER BY updated_at DESC", [ownerId]);
    return rows.map(r => ({
      id: r.id,
      ownerId: r.owner_id,
      endpoint: r.endpoint,
      p256dh: r.p256dh,
      auth: r.auth,
      userAgent: r.user_agent,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async getMostRecentPushSubscription(ownerId: string): Promise<PushSubscriptionRecord | null> {
    const rows = await this.db.all<{
      id: string;
      owner_id: string;
      endpoint: string;
      p256dh: string;
      auth: string;
      user_agent: string | null;
      created_at: string;
      updated_at: string;
    }>(
      "SELECT * FROM push_subscriptions WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 1",
      [ownerId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      ownerId: r.owner_id,
      endpoint: r.endpoint,
      p256dh: r.p256dh,
      auth: r.auth,
      userAgent: r.user_agent,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async removePushSubscription(ownerId: string, endpoint: string): Promise<void> {
    await this.db.batch([
      {
        sql: "DELETE FROM push_subscriptions WHERE owner_id = ? AND endpoint = ?",
        values: [ownerId, endpoint],
      },
    ]);
  }
}
