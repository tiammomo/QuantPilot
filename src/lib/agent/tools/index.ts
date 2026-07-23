import type { MoAgentTool } from '@/lib/agent/types';
import { firstPartyContextReceiptProjector } from './context-receipts';
import { createMoAgentFileTools, type MoAgentFileToolOptions } from './filesystem';
import { createSemanticEditTool } from './semantic-edit';
import {
  createQueryJsonTool,
  createQueryTextFileTool,
  type MoAgentJsonArtifactConfiguration,
} from './structured-read';
import { createSubmitResultTool } from './submit-result';
import { composeMoAgentToolset } from './toolset';

export type MoAgentToolProfile = 'generation' | 'repair';
export type MoAgentPreparedToolSurface = 'standard' | 'custom';

export interface CreateMoAgentToolsOptions extends MoAgentFileToolOptions {
  profile?: MoAgentToolProfile;
  profileAllowedWriteGlobs?: readonly string[];
  targetedReadsOnly?: boolean;
  /** Domain/delivery-owned authoritative JSON handles and optional aliases. */
  jsonArtifacts?: MoAgentJsonArtifactConfiguration;
  preparedSurface?: MoAgentPreparedToolSurface;
  /** Domain/delivery-owned compiler used by a deterministic standard lane. */
  preparedCompilerTool?: MoAgentTool | null;
  /** Domain/delivery inspectors exposed only before a prepared contract exists. */
  inspectionTools?: readonly MoAgentTool[];
  includeSemanticEdit?: boolean;
  allowedMutationToolNames?: readonly string[];
  /** Trusted typed tools registered by the application composition root. */
  trustedAdditionalTools?: readonly MoAgentTool[];
  /** Trusted tools intentionally ordered after the terminal submission schema. */
  trustedTrailingTools?: readonly MoAgentTool[];
  /** Plugin tools cross an untrusted receipt-projector boundary. */
  additionalTools?: readonly MoAgentTool[];
  /** Trusted application/domain projector registry composed ahead of core defaults. */
  contextReceiptProjector?: (
    toolName: string,
  ) => MoAgentTool['projectContextReceipt'] | undefined;
}

/** Generation authors source/UI only; data/evidence writes require explicit domain scope. */
export const MOAGENT_GENERATION_ALLOWED_WRITE_GLOBS = [] as const;

/** Structured data/evidence paths supported by the generic workspace reader. */
export const MOAGENT_GENERATION_STRUCTURED_JSON_READ_GLOBS = [
  'data/**/*.json',
  'data_file/final/**/*.json',
  'evidence/**/*.json',
] as const;

const GENERIC_READ_TOOL_NAMES = new Set([
  'list_files',
  'read_file',
  'read_file_range',
  'search_files',
]);

export function allowedWriteGlobsForMoAgentProfile(
  profile: MoAgentToolProfile,
): readonly string[] {
  return profile === 'repair' ? [] : MOAGENT_GENERATION_ALLOWED_WRITE_GLOBS;
}

/**
 * Product-neutral workspace Tool factory. Domain packages contribute only
 * typed tools and a prepared compiler; no finance endpoint is enabled here.
 */
export function createMoAgentTools(options: CreateMoAgentToolsOptions): MoAgentTool[] {
  const profile = options.profile ?? 'generation';
  if (profile === 'repair' && options.profileAllowedWriteGlobs === undefined) {
    throw new Error('MoAgent repair tools require a trusted failure-scoped write allowlist.');
  }
  const allowedWriteGlobs = [
    ...(options.profileAllowedWriteGlobs ?? allowedWriteGlobsForMoAgentProfile(profile)),
    ...(options.allowedWriteGlobs ?? []),
  ];
  const workspaceOptions = {
    ...options,
    allowedWriteGlobs,
    structuredJsonReadGlobs: options.structuredJsonReadGlobs ?? (
      profile === 'generation' ? MOAGENT_GENERATION_STRUCTURED_JSON_READ_GLOBS : []
    ),
  };
  if (options.preparedSurface && options.includeDefaultWriteGlobs !== false) {
    throw new Error(
      'MoAgent prepared surfaces require includeDefaultWriteGlobs=false and an explicit write scope.',
    );
  }
  const fileTools = createMoAgentFileTools(workspaceOptions);
  const semanticEditTool = options.includeSemanticEdit
    ? createSemanticEditTool(workspaceOptions)
    : null;
  const queryJsonTool = createQueryJsonTool(workspaceOptions);
  const queryTextFileTool = createQueryTextFileTool(workspaceOptions);
  const submitResultTool = createSubmitResultTool({
    workspaceRoot: options.workspaceRoot,
    timeoutMs: options.timeoutMs,
  });
  if (options.preparedSurface === 'standard' && !options.preparedCompilerTool) {
    throw new Error('MoAgent prepared standard surface requires a domain delivery compiler.');
  }
  if (options.preparedSurface === 'custom' && !semanticEditTool) {
    throw new Error('MoAgent prepared custom surface requires semantic_edit.');
  }
  if (
    options.preparedSurface &&
    ((options.inspectionTools?.length ?? 0) > 0 ||
      (options.trustedAdditionalTools?.length ?? 0) > 0 ||
      (options.trustedTrailingTools?.length ?? 0) > 0 ||
      (options.additionalTools?.length ?? 0) > 0)
  ) {
    throw new Error('MoAgent prepared surfaces reject inspection, domain data and plugin tools.');
  }

  const trustedTools: MoAgentTool[] = options.preparedSurface === 'standard'
    ? [options.preparedCompilerTool!, submitResultTool]
    : options.preparedSurface === 'custom'
      ? [queryJsonTool, queryTextFileTool, semanticEditTool!, submitResultTool]
      : [
          ...(options.targetedReadsOnly
            ? fileTools.filter((tool) => !GENERIC_READ_TOOL_NAMES.has(tool.name))
            : fileTools),
          ...(options.inspectionTools ?? []),
          queryJsonTool,
          queryTextFileTool,
          ...(options.preparedCompilerTool ? [options.preparedCompilerTool] : []),
          ...(semanticEditTool ? [semanticEditTool] : []),
          ...(options.trustedAdditionalTools ?? []),
          submitResultTool,
          ...(options.trustedTrailingTools ?? []),
        ];
  return composeMoAgentToolset({
    trustedTools,
    extensionTools: options.additionalTools,
    allowedMutationToolNames: options.allowedMutationToolNames,
    contextReceiptProjector: (toolName) =>
      options.contextReceiptProjector?.(toolName) ??
      firstPartyContextReceiptProjector(toolName),
  });
}

export * from './errors';
export * from './context-receipts';
export * from './filesystem';
export * from './path-policy';
export * from './runtime';
export * from './semantic-edit';
export * from './structured-read';
export * from './submit-result';
export * from './toolset';
