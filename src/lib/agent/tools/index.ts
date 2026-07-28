import type { PiAgentTool } from '@/lib/agent/types';
import { firstPartyContextReceiptProjector } from './context-receipts';
import { createPiAgentFileTools, type PiAgentFileToolOptions } from './filesystem';
import { createSemanticEditTool } from './semantic-edit';
import {
  createQueryJsonTool,
  createQueryTextFileTool,
  type PiAgentJsonArtifactConfiguration,
} from './structured-read';
import { createSubmitResultTool } from './submit-result';
import { composePiAgentToolset } from './toolset';

export type PiAgentToolProfile = 'generation' | 'repair';
export type PiAgentPreparedToolSurface = 'standard' | 'custom';

export interface CreatePiAgentToolsOptions extends PiAgentFileToolOptions {
  profile?: PiAgentToolProfile;
  profileAllowedWriteGlobs?: readonly string[];
  targetedReadsOnly?: boolean;
  /** Domain/delivery-owned authoritative JSON handles and optional aliases. */
  jsonArtifacts?: PiAgentJsonArtifactConfiguration;
  preparedSurface?: PiAgentPreparedToolSurface;
  /** Domain/delivery-owned compiler used by a deterministic standard lane. */
  preparedCompilerTool?: PiAgentTool | null;
  /** Domain/delivery inspectors exposed only before a prepared contract exists. */
  inspectionTools?: readonly PiAgentTool[];
  includeSemanticEdit?: boolean;
  allowedMutationToolNames?: readonly string[];
  /** Trusted typed tools registered by the application composition root. */
  trustedAdditionalTools?: readonly PiAgentTool[];
  /** Trusted tools intentionally ordered after the terminal submission schema. */
  trustedTrailingTools?: readonly PiAgentTool[];
  /** Plugin tools cross an untrusted receipt-projector boundary. */
  additionalTools?: readonly PiAgentTool[];
  /** Trusted application/domain projector registry composed ahead of core defaults. */
  contextReceiptProjector?: (
    toolName: string,
  ) => PiAgentTool['projectContextReceipt'] | undefined;
}

/** Generation authors source/UI only; data/evidence writes require explicit domain scope. */
export const PI_AGENT_GENERATION_ALLOWED_WRITE_GLOBS = [] as const;

/** Structured data/evidence paths supported by the generic workspace reader. */
export const PI_AGENT_GENERATION_STRUCTURED_JSON_READ_GLOBS = [
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

export function allowedWriteGlobsForPiAgentProfile(
  profile: PiAgentToolProfile,
): readonly string[] {
  return profile === 'repair' ? [] : PI_AGENT_GENERATION_ALLOWED_WRITE_GLOBS;
}

/**
 * Product-neutral workspace Tool factory. Domain packages contribute only
 * typed tools and a prepared compiler; no finance endpoint is enabled here.
 */
export function createPiAgentTools(options: CreatePiAgentToolsOptions): PiAgentTool[] {
  const profile = options.profile ?? 'generation';
  if (profile === 'repair' && options.profileAllowedWriteGlobs === undefined) {
    throw new Error('PI Agent repair tools require a trusted failure-scoped write allowlist.');
  }
  const allowedWriteGlobs = [
    ...(options.profileAllowedWriteGlobs ?? allowedWriteGlobsForPiAgentProfile(profile)),
    ...(options.allowedWriteGlobs ?? []),
  ];
  const workspaceOptions = {
    ...options,
    allowedWriteGlobs,
    structuredJsonReadGlobs: options.structuredJsonReadGlobs ?? (
      profile === 'generation' ? PI_AGENT_GENERATION_STRUCTURED_JSON_READ_GLOBS : []
    ),
  };
  if (options.preparedSurface && options.includeDefaultWriteGlobs !== false) {
    throw new Error(
      'PI Agent prepared surfaces require includeDefaultWriteGlobs=false and an explicit write scope.',
    );
  }
  const fileTools = createPiAgentFileTools(workspaceOptions);
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
    throw new Error('PI Agent prepared standard surface requires a domain delivery compiler.');
  }
  if (options.preparedSurface === 'custom' && !semanticEditTool) {
    throw new Error('PI Agent prepared custom surface requires semantic_edit.');
  }
  if (
    options.preparedSurface &&
    ((options.inspectionTools?.length ?? 0) > 0 ||
      (options.trustedAdditionalTools?.length ?? 0) > 0 ||
      (options.trustedTrailingTools?.length ?? 0) > 0 ||
      (options.additionalTools?.length ?? 0) > 0)
  ) {
    throw new Error('PI Agent prepared surfaces reject inspection, domain data and plugin tools.');
  }

  const trustedTools: PiAgentTool[] = options.preparedSurface === 'standard'
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
  return composePiAgentToolset({
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
