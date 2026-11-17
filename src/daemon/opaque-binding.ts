import type { SessionBinding } from "../interact-types";

export interface OpaqueAgentEndpoint {
  adapter: string;
  ref: string;
}

export interface OpaqueBindingV1 {
  v: 1;
  agent?: OpaqueAgentEndpoint | null;
  cwd?: string | null;
  sourceFile?: string | null;
  demoMode?: boolean;
}

interface DecodedOpaqueLegacy extends OpaqueBindingV1 {
  primary?: OpaqueAgentEndpoint | null;
  fallback?: OpaqueAgentEndpoint | null;
}

const KNOWN_DIRECT_ADAPTERS = new Set(["claude", "codex", "agy", "grok"]);

export function encodeOpaqueBinding(input: Omit<OpaqueBindingV1, "v">): string {
  const payload: OpaqueBindingV1 = {
    v: 1,
    ...(input.agent ? { agent: { adapter: input.agent.adapter, ref: input.agent.ref } } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.sourceFile ? { sourceFile: input.sourceFile } : {}),
    ...(input.demoMode ? { demoMode: true } : {}),
  };
  return JSON.stringify(payload);
}

export function decodeOpaqueBinding(raw: string | null | undefined): OpaqueBindingV1 | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DecodedOpaqueLegacy>;
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1) return null;

    let agent: OpaqueAgentEndpoint | null = null;
    if (parsed.agent?.adapter && parsed.agent?.ref) {
      agent = { adapter: parsed.agent.adapter, ref: parsed.agent.ref };
    } else if (
      parsed.primary?.adapter &&
      parsed.primary?.ref &&
      KNOWN_DIRECT_ADAPTERS.has(parsed.primary.adapter)
    ) {
      agent = { adapter: parsed.primary.adapter, ref: parsed.primary.ref };
    } else if (
      parsed.fallback?.adapter &&
      parsed.fallback?.ref &&
      KNOWN_DIRECT_ADAPTERS.has(parsed.fallback.adapter)
    ) {
      agent = { adapter: parsed.fallback.adapter, ref: parsed.fallback.ref };
    }

    return {
      v: 1,
      ...(agent ? { agent } : {}),
      cwd: parsed.cwd ?? null,
      sourceFile: parsed.sourceFile ?? null,
      ...(parsed.demoMode ? { demoMode: true } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Unpacks a server-delivered `SessionBinding` into a concrete coding-agent session binding.
 */
export function unpackEnvelopeBinding(binding: SessionBinding): SessionBinding {
  const decoded = decodeOpaqueBinding(binding.opaqueBinding);
  if (!decoded) {
    if (!KNOWN_DIRECT_ADAPTERS.has(binding.adapterId) && binding.adapterId !== "auto") {
      return {
        ...binding,
        adapterId: "auto",
        sessionRef: "adhoc",
      };
    }
    return binding;
  }

  const agent = decoded.agent ?? null;
  const mergedMeta: Record<string, unknown> = {
    ...(binding.adapterMeta ?? {}),
    ...(decoded.demoMode ? { demoMode: true } : {}),
  };

  return {
    ...binding,
    adapterId: agent?.adapter || "auto",
    sessionRef: agent?.ref || "adhoc",
    cwd: decoded.cwd ?? binding.cwd ?? null,
    sourceFile: decoded.sourceFile ?? binding.sourceFile ?? null,
    adapterMeta: mergedMeta,
  };
}

export function adapterDisplayLabel(adapterId: string): string {
  switch (adapterId) {
    case "claude":
      return "Claude";
    case "agy":
      return "Antigravity";
    case "codex":
      return "Codex";
    case "grok":
      return "Grok";
    default:
      return adapterId || "Agent";
  }
}
