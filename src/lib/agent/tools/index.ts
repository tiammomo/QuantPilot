import type { MoAgentTool } from '@/lib/agent/types';
import { createInspectDashboardContractTool } from './dashboard-contract';
import { createApplyDashboardSpecTool } from './dashboard-spec';
import { createMoAgentFileTools, type MoAgentFileToolOptions } from './filesystem';
import {
  createImageExtractionTool,
  type MoAgentImageExtractionToolOptions,
} from './image-extraction';
import { createQuantApiGetTool, type MoAgentQuantApiToolOptions } from './quant-api';
import { createSemanticEditTool } from './semantic-edit';
import { createQueryJsonTool, createQueryTextFileTool } from './structured-read';
import { createSubmitResultTool } from './submit-result';
import { firstPartyContextReceiptProjector } from './context-receipts';

export interface CreateMoAgentToolsOptions extends MoAgentFileToolOptions {
  profile?: MoAgentToolProfile;
  /** Trusted per-run override for the profile's extra write surface. */
  profileAllowedWriteGlobs?: readonly string[];
  quantApi?: MoAgentQuantApiToolOptions;
  /** Disable the live quant-data tool when the platform already prepared all datasets. */
  includeQuantApi?: boolean;
  /** Expose batched query_json/query_text_file readers plus mutation tools; removes generic discovery/scanning. */
  targetedReadsOnly?: boolean;
  /**
   * Minimise the provider-visible schema for an already prepared workspace.
   * Standard mode keeps a recoverable compiler path; custom mode exposes only
   * bounded structured reads plus hash-guarded semantic edits.
   */
  preparedSurface?: 'standard' | 'custom';
  /** Expose the trusted platform-template compiler for prepared dashboard generations. */
  includeDashboardSpec?: boolean;
  /** Expose hash-guarded AST/CSS/range edits after targeted source reads. */
  includeSemanticEdit?: boolean;
  imageExtraction?: Omit<MoAgentImageExtractionToolOptions, 'workspaceRoot'>;
  includeImageExtraction?: boolean;
  /** Product-specific typed tools (for example image extraction). */
  additionalTools?: readonly MoAgentTool[];
}

export type MoAgentToolProfile = 'generation' | 'repair';

/** Generation authors source/UI only; platform-prepared final/evidence stay untouched. */
export const MOAGENT_GENERATION_ALLOWED_WRITE_GLOBS = [] as const;

/** Platform-prefetched data is queried structurally instead of replayed raw. */
export const MOAGENT_GENERATION_STRUCTURED_JSON_READ_GLOBS = [
  'data_file/final/**/*.json',
  'evidence/**/*.json',
] as const;

/** Prepared dashboards may only mutate the app entry surface they render. */
export const MOAGENT_PREPARED_SOURCE_WRITE_GLOBS = [
  'app/page.tsx',
  'app/globals.css',
] as const;

const MOAGENT_GENERIC_READ_TOOL_NAMES = new Set([
  'list_files',
  'read_file',
  'read_file_range',
  'search_files',
]);

export function allowedWriteGlobsForMoAgentProfile(profile: MoAgentToolProfile): readonly string[] {
  // Repair must supply its platform-compiled failure scope explicitly.
  return profile === 'repair' ? [] : MOAGENT_GENERATION_ALLOWED_WRITE_GLOBS;
}

/**
 * The first-party MoAgent tool set deliberately contains no Bash/shell tool.
 * All filesystem and quant-data capabilities are typed and policy constrained.
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
  const structuredJsonReadGlobs = options.structuredJsonReadGlobs ?? (
    profile === 'generation' ? MOAGENT_GENERATION_STRUCTURED_JSON_READ_GLOBS : []
  );
  const workspaceOptions = {
    ...options,
    allowedWriteGlobs,
    structuredJsonReadGlobs,
  };
  const fileTools = createMoAgentFileTools(workspaceOptions);
  const dashboardSpecTool = options.includeDashboardSpec
    ? createApplyDashboardSpecTool(workspaceOptions)
    : null;
  const semanticEditTool = options.includeSemanticEdit
    ? createSemanticEditTool(workspaceOptions)
    : null;
  const queryJsonTool = createQueryJsonTool(options);
  const queryTextFileTool = createQueryTextFileTool(options);
  const submitResultTool = createSubmitResultTool({
    workspaceRoot: options.workspaceRoot,
    timeoutMs: options.timeoutMs,
  });
  if (
    options.preparedSurface &&
    (options.includeQuantApi !== false ||
      options.includeImageExtraction !== false ||
      (options.additionalTools?.length ?? 0) > 0)
  ) {
    throw new Error(
      'MoAgent prepared surfaces require quant API, image extraction, and additional tools to be disabled.',
    );
  }
  if (options.preparedSurface && options.includeDefaultWriteGlobs !== false) {
    throw new Error(
      'MoAgent prepared surfaces require includeDefaultWriteGlobs=false and an explicit app-only write scope.',
    );
  }
  if (
    options.preparedSurface &&
    allowedWriteGlobs.some((glob) =>
      !MOAGENT_PREPARED_SOURCE_WRITE_GLOBS.includes(
        glob as (typeof MOAGENT_PREPARED_SOURCE_WRITE_GLOBS)[number],
      ))
  ) {
    throw new Error('MoAgent prepared surfaces reject write globs outside the certified app source scope.');
  }
  if (options.preparedSurface === 'standard' && !dashboardSpecTool) {
    throw new Error('MoAgent prepared standard surface requires apply_dashboard_spec.');
  }
  if (options.preparedSurface === 'custom' && !semanticEditTool) {
    throw new Error('MoAgent prepared custom surface requires semantic_edit.');
  }
  const preparedTools: MoAgentTool[] | null = options.preparedSurface === 'standard'
    ? [
        dashboardSpecTool!,
        submitResultTool,
      ]
    : options.preparedSurface === 'custom'
      ? [queryJsonTool, queryTextFileTool, semanticEditTool!, submitResultTool]
      : null;
  const tools: MoAgentTool[] = [
    ...(preparedTools ?? [
      ...(options.targetedReadsOnly
        ? fileTools.filter((tool) => !MOAGENT_GENERIC_READ_TOOL_NAMES.has(tool.name))
        : fileTools),
      createInspectDashboardContractTool(options),
      queryJsonTool,
      queryTextFileTool,
      ...(dashboardSpecTool ? [dashboardSpecTool] : []),
      ...(semanticEditTool ? [semanticEditTool] : []),
      ...(options.includeQuantApi === false ? [] : [createQuantApiGetTool({
        timeoutMs: options.timeoutMs,
        maxOutputChars: options.maxOutputChars,
        ...options.quantApi,
      })]),
      submitResultTool,
      ...(options.includeImageExtraction === false ? [] : [createImageExtractionTool({
        workspaceRoot: options.workspaceRoot,
        timeoutMs: options.timeoutMs,
        maxOutputChars: options.maxOutputChars,
        ...options.imageExtraction,
      })]),
      ...(options.additionalTools ?? []),
    ]),
  ];
  const seen = new Set<string>();
  const additionalTools = new Set(options.additionalTools ?? []);
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`Duplicate MoAgent tool name: ${tool.name}`);
    seen.add(tool.name);
  }
  return tools.map((tool) => {
    if (additionalTools.has(tool)) {
      // Trust is assigned by the framework, never inherited from a product
      // supplied tool object.
      const { projectContextReceipt: _untrustedProjector, ...untrustedTool } = tool;
      return untrustedTool;
    }
    const projectContextReceipt = firstPartyContextReceiptProjector(tool.name);
    return projectContextReceipt ? { ...tool, projectContextReceipt } : tool;
  });
}

export * from './errors';
export * from './dashboard-contract';
export * from './context-receipts';
export * from './dashboard-spec';
export * from './filesystem';
export * from './image-extraction';
export * from './path-policy';
export * from './quant-api';
export * from './runtime';
export * from './semantic-edit';
export * from './structured-read';
export * from './submit-result';
