import type { PiAgentTool } from '@/lib/agent/types';
import {
  createPiAgentTools,
  type CreatePiAgentToolsOptions,
  type PiAgentToolProfile,
} from '@/lib/agent/tools';
import { createInspectDashboardContractTool } from './dashboard-contract';
import {
  createApplyDashboardSpecTool,
} from './dashboard-spec';
import {
  createImageExtractionTool,
  type PiAgentImageExtractionToolOptions,
} from './image-extraction';
import {
  createQuantApiGetTool,
  type PiAgentQuantApiToolOptions,
} from './quant-api';
import { financeContextReceiptProjector } from './context-receipts';
import { FINANCE_JSON_ARTIFACT_CONFIGURATION } from './structured-read';

export const FINANCE_PREPARED_SOURCE_WRITE_GLOBS = [
  'app/page.tsx',
  'app/globals.css',
] as const;

export interface CreateFinancePiAgentToolsOptions
  extends Omit<
    CreatePiAgentToolsOptions,
    'preparedCompilerTool' | 'inspectionTools' | 'trustedAdditionalTools' | 'trustedTrailingTools'
  > {
  profile?: PiAgentToolProfile;
  quantApi?: PiAgentQuantApiToolOptions;
  includeQuantApi?: boolean;
  includeDashboardSpec?: boolean;
  includeDashboardInspector?: boolean;
  imageExtraction?: Omit<PiAgentImageExtractionToolOptions, 'workspaceRoot'>;
  includeImageExtraction?: boolean;
}

/** Finance Domain Pack adapter over the product-neutral PI Agent Tool factory. */
export function createFinancePiAgentTools(
  options: CreateFinancePiAgentToolsOptions,
): PiAgentTool[] {
  const allowedWriteGlobs = [
    ...(options.profileAllowedWriteGlobs ?? []),
    ...(options.allowedWriteGlobs ?? []),
  ];
  if (
    options.preparedSurface &&
    (options.includeQuantApi !== false ||
      options.includeImageExtraction !== false ||
      (options.additionalTools?.length ?? 0) > 0)
  ) {
    throw new Error(
      'Finance prepared surfaces require quant API, image extraction, and plugin tools to be disabled.',
    );
  }
  if (
    options.preparedSurface &&
    allowedWriteGlobs.some((glob) =>
      !FINANCE_PREPARED_SOURCE_WRITE_GLOBS.includes(
        glob as (typeof FINANCE_PREPARED_SOURCE_WRITE_GLOBS)[number],
      ))
  ) {
    throw new Error('Finance prepared surfaces reject writes outside the certified app source scope.');
  }
  const workspaceOptions = {
    ...options,
    allowedWriteGlobs,
  };
  const preparedCompilerTool = options.includeDashboardSpec
    ? createApplyDashboardSpecTool(workspaceOptions)
    : null;
  const inspectionTools = options.includeDashboardInspector === false
    ? []
    : [createInspectDashboardContractTool(options)];
  const trustedAdditionalTools: PiAgentTool[] = options.includeQuantApi === false ? [] : [
    createQuantApiGetTool({
      timeoutMs: options.timeoutMs,
      maxOutputChars: options.maxOutputChars,
      ...options.quantApi,
    }),
  ];
  const trustedTrailingTools: PiAgentTool[] = options.includeImageExtraction === false ? [] : [
    createImageExtractionTool({
      workspaceRoot: options.workspaceRoot,
      timeoutMs: options.timeoutMs,
      maxOutputChars: options.maxOutputChars,
      ...options.imageExtraction,
    }),
  ];
  return createPiAgentTools({
    ...options,
    jsonArtifacts: FINANCE_JSON_ARTIFACT_CONFIGURATION,
    preparedCompilerTool,
    inspectionTools: options.preparedSurface ? [] : inspectionTools,
    trustedAdditionalTools: options.preparedSurface ? [] : trustedAdditionalTools,
    trustedTrailingTools: options.preparedSurface ? [] : trustedTrailingTools,
    contextReceiptProjector: financeContextReceiptProjector,
  });
}
