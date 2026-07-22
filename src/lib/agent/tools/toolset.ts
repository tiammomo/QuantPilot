import type { MoAgentTool } from '@/lib/agent/types';

export interface ComposeMoAgentToolsetOptions {
  /** Framework/application-owned tools whose bounded receipt projectors are trusted. */
  trustedTools: readonly MoAgentTool[];
  /** Domain/plugin tools; embedded receipt projectors are stripped at the trust boundary. */
  extensionTools?: readonly MoAgentTool[];
  allowedMutationToolNames?: readonly string[];
  contextReceiptProjector?: (
    toolName: string,
  ) => MoAgentTool['projectContextReceipt'] | undefined;
}

/**
 * Product-neutral tool composition boundary. Domains contribute typed tools;
 * the framework keeps duplicate-name, mutation-scope and receipt trust rules.
 */
export function composeMoAgentToolset(options: ComposeMoAgentToolsetOptions): MoAgentTool[] {
  const extensionTools = new Set(options.extensionTools ?? []);
  const candidates = [...options.trustedTools, ...(options.extensionTools ?? [])];
  const seen = new Set<string>();
  for (const tool of candidates) {
    if (seen.has(tool.name)) throw new Error(`Duplicate MoAgent tool name: ${tool.name}`);
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
    throw new Error(`Unknown MoAgent mutation tool allowlist entries: ${unknown.join(', ')}`);
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
        const { projectContextReceipt: _untrustedProjector, ...untrustedTool } = tool;
        return untrustedTool;
      }
      const projector = options.contextReceiptProjector?.(tool.name);
      return projector ? { ...tool, projectContextReceipt: projector } : tool;
    });
}
