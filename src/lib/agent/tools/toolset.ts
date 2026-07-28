import type { PiAgentTool } from '@/lib/agent/types';

export interface ComposePiAgentToolsetOptions {
  /** Framework/application-owned tools whose bounded receipt projectors are trusted. */
  trustedTools: readonly PiAgentTool[];
  /** Domain/plugin tools; embedded trust projectors are stripped at the boundary. */
  extensionTools?: readonly PiAgentTool[];
  allowedMutationToolNames?: readonly string[];
  contextReceiptProjector?: (
    toolName: string,
  ) => PiAgentTool['projectContextReceipt'] | undefined;
}

/**
 * Product-neutral tool composition boundary. Domains contribute typed tools;
 * the framework keeps duplicate-name, mutation-scope and receipt trust rules.
 */
export function composePiAgentToolset(options: ComposePiAgentToolsetOptions): PiAgentTool[] {
  const extensionTools = new Set(options.extensionTools ?? []);
  const candidates = [...options.trustedTools, ...(options.extensionTools ?? [])];
  const seen = new Set<string>();
  for (const tool of candidates) {
    if (seen.has(tool.name)) throw new Error(`Duplicate PI Agent tool name: ${tool.name}`);
    seen.add(tool.name);
  }
  const registeredMutationToolNames = new Set(
    candidates
      .filter((tool) => {
        const effect = tool.effect ?? 'external_write';
        return effect === 'workspace_write' || effect === 'external_write';
      })
      .map((tool) => tool.name),
  );
  const allowedMutationToolNames = options.allowedMutationToolNames
    ? new Set(options.allowedMutationToolNames)
    : null;
  if (
    allowedMutationToolNames &&
    [...allowedMutationToolNames].some((name) => !registeredMutationToolNames.has(name))
  ) {
    const unknown = [...allowedMutationToolNames]
      .filter((name) => !registeredMutationToolNames.has(name));
    throw new Error(`Unknown PI Agent mutation tool allowlist entries: ${unknown.join(', ')}`);
  }
  return candidates
    .filter((tool) => {
      if (!allowedMutationToolNames) return true;
      const effect = tool.effect ?? 'external_write';
      return (
        effect !== 'workspace_write' && effect !== 'external_write'
      ) || allowedMutationToolNames.has(tool.name);
    })
    .map((tool) => {
      if (extensionTools.has(tool)) {
        const {
          projectContextReceipt: _untrustedReceiptProjector,
          approval: _untrustedApprovalProjector,
          ...untrustedTool
        } = tool;
        return untrustedTool;
      }
      const projector = options.contextReceiptProjector?.(tool.name);
      return projector ? { ...tool, projectContextReceipt: projector } : tool;
    });
}
