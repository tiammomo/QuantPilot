import type { MoAgentTool } from '@/lib/agent/types';
import { createInspectDashboardContractTool } from './dashboard-contract';
import { createMoAgentFileTools, type MoAgentFileToolOptions } from './filesystem';
import {
  createImageExtractionTool,
  type MoAgentImageExtractionToolOptions,
} from './image-extraction';
import { createQuantApiGetTool, type MoAgentQuantApiToolOptions } from './quant-api';
import { createQueryJsonTool, createQueryTextFileTool } from './structured-read';
import { createSubmitResultTool } from './submit-result';

export interface CreateMoAgentToolsOptions extends MoAgentFileToolOptions {
  profile?: MoAgentToolProfile;
  quantApi?: MoAgentQuantApiToolOptions;
  /** Disable the live quant-data tool when the platform already prepared all datasets. */
  includeQuantApi?: boolean;
  /** Expose batched query_json/query_text_file readers plus mutation tools; removes generic discovery/scanning. */
  targetedReadsOnly?: boolean;
  imageExtraction?: Omit<MoAgentImageExtractionToolOptions, 'workspaceRoot'>;
  includeImageExtraction?: boolean;
  /** Product-specific typed tools (for example image extraction). */
  additionalTools?: readonly MoAgentTool[];
}

export type MoAgentToolProfile = 'generation' | 'repair';

/** Generation authors source/UI only; platform-prepared final/evidence stay untouched. */
export const MOAGENT_GENERATION_ALLOWED_WRITE_GLOBS = [] as const;

/** Repair gets narrowly scoped authority for validation-directed data contract fixes. */
export const MOAGENT_REPAIR_ALLOWED_WRITE_GLOBS = [
  'data_file/final/**',
  'evidence/**',
] as const;

/** Platform-prefetched data is queried structurally instead of replayed raw. */
export const MOAGENT_GENERATION_STRUCTURED_JSON_READ_GLOBS = [
  'data_file/final/**/*.json',
  'evidence/**/*.json',
] as const;

const MOAGENT_GENERIC_READ_TOOL_NAMES = new Set([
  'list_files',
  'read_file',
  'read_file_range',
  'search_files',
]);

export function allowedWriteGlobsForMoAgentProfile(profile: MoAgentToolProfile): readonly string[] {
  return profile === 'repair'
    ? MOAGENT_REPAIR_ALLOWED_WRITE_GLOBS
    : MOAGENT_GENERATION_ALLOWED_WRITE_GLOBS;
}

/**
 * The first-party MoAgent tool set deliberately contains no Bash/shell tool.
 * All filesystem and quant-data capabilities are typed and policy constrained.
 */
export function createMoAgentTools(options: CreateMoAgentToolsOptions): MoAgentTool[] {
  const profile = options.profile ?? 'generation';
  const allowedWriteGlobs = [
    ...allowedWriteGlobsForMoAgentProfile(profile),
    ...(options.allowedWriteGlobs ?? []),
  ];
  const structuredJsonReadGlobs = options.structuredJsonReadGlobs ?? (
    profile === 'generation' ? MOAGENT_GENERATION_STRUCTURED_JSON_READ_GLOBS : []
  );
  const fileTools = createMoAgentFileTools({
    ...options,
    allowedWriteGlobs,
    structuredJsonReadGlobs,
  });
  const tools: MoAgentTool[] = [
    ...(options.targetedReadsOnly
      ? fileTools.filter((tool) => !MOAGENT_GENERIC_READ_TOOL_NAMES.has(tool.name))
      : fileTools),
    createInspectDashboardContractTool(options),
    createQueryJsonTool(options),
    createQueryTextFileTool(options),
    ...(options.includeQuantApi === false ? [] : [createQuantApiGetTool({
      timeoutMs: options.timeoutMs,
      maxOutputChars: options.maxOutputChars,
      ...options.quantApi,
    })]),
    createSubmitResultTool({ workspaceRoot: options.workspaceRoot, timeoutMs: options.timeoutMs }),
    ...(options.includeImageExtraction === false ? [] : [createImageExtractionTool({
      workspaceRoot: options.workspaceRoot,
      timeoutMs: options.timeoutMs,
      maxOutputChars: options.maxOutputChars,
      ...options.imageExtraction,
    })]),
    ...(options.additionalTools ?? []),
  ];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`Duplicate MoAgent tool name: ${tool.name}`);
    seen.add(tool.name);
  }
  return tools;
}

export * from './errors';
export * from './dashboard-contract';
export * from './filesystem';
export * from './image-extraction';
export * from './path-policy';
export * from './quant-api';
export * from './runtime';
export * from './structured-read';
export * from './submit-result';
