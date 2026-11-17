import type { AgentSessionSummary, CodingAgentAdapter } from "../interact-types";
import {
  AgyAdapter,
  GrokAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
  type AcpExecutor,
} from "./adapters/acp-agent";

export class AdapterRegistry {
  private readonly adapters = new Map<string, CodingAgentAdapter>();

  register(adapter: CodingAgentAdapter): this {
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: string): CodingAgentAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): CodingAgentAdapter[] {
    return [...this.adapters.values()];
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }

  async listSessions(opts?: {
    adapterId?: string;
    cwd?: string;
    limit?: number;
  }): Promise<AgentSessionSummary[]> {
    const targets = opts?.adapterId
      ? [this.adapters.get(opts.adapterId)].filter((a): a is CodingAgentAdapter => Boolean(a))
      : this.list();
    const lists = await Promise.all(
      targets.map(a => a.listSessions({ cwd: opts?.cwd, limit: opts?.limit }).catch(() => [])),
    );
    const merged = lists.flat();
    merged.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return typeof opts?.limit === "number" ? merged.slice(0, Math.max(1, opts.limit)) : merged;
  }
}

export function createDefaultRegistry(opts?: {
  acpExecutor?: AcpExecutor;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): AdapterRegistry {
  const shared = {
    executor: opts?.acpExecutor,
    homeDir: opts?.homeDir,
    env: opts?.env,
  };
  const registry = new AdapterRegistry();
  registry.register(new CodexAdapter(shared));
  registry.register(new AgyAdapter(shared));
  registry.register(new ClaudeCodeAdapter(shared));
  registry.register(new GrokAdapter(shared));
  return registry;
}
