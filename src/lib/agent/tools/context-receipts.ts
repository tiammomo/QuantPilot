import { createHash } from 'node:crypto';

import type {
  MoAgentTool,
  MoAgentToolContextReceipt,
  MoAgentToolResult,
} from '@/lib/agent/types';

type ContextReceiptProjector = NonNullable<MoAgentTool['projectContextReceipt']>;

const DASHBOARD_CONTRACT_TARGETS = [
  '.quantpilot/run_plan.json',
  'data_file/final/dashboard-data.json',
  'evidence/sources.json',
  'evidence/data-quality.json',
  'app/page.tsx',
  'app/globals.css',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  const candidate = isRecord(value) ? value[key] : undefined;
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0
    ? candidate
    : undefined;
}

function resultData(result: MoAgentToolResult): unknown {
  return result.ok ? result.data : undefined;
}

function pathReceipt(
  input: unknown,
  result: MoAgentToolResult,
  options: { digestKey?: string } = {},
): MoAgentToolContextReceipt {
  const data = resultData(result);
  const path = stringField(data, 'path') ?? stringField(input, 'path');
  const digestKey = options.digestKey ?? 'sha256';
  const artifactSha256 = stringField(data, digestKey);
  const bytes = numberField(data, 'bytes');
  return {
    targetReferences: path ? [path] : [],
    ...(artifactSha256 ? { artifactSha256 } : {}),
    ...(bytes === undefined ? {} : { bytes }),
  };
}

function dashboardSpecReceipt(result: MoAgentToolResult): MoAgentToolContextReceipt {
  if (!result.ok || !isRecord(result.data) || !Array.isArray(result.data.files)) {
    return { targetReferences: ['app/page.tsx', 'app/globals.css'] };
  }
  const targets = result.data.files
    .slice(0, 16)
    .map((file) => stringField(file, 'path'))
    .filter((path): path is string => path !== undefined);
  const artifactEntries = result.data.files
    .slice(0, 16)
    .map((file) => ({
      path: stringField(file, 'path'),
      afterSha256: stringField(file, 'afterSha256'),
    }))
    .filter((file): file is { path: string; afterSha256: string } =>
      file.path !== undefined && file.afterSha256 !== undefined)
    .sort((left, right) => left.path.localeCompare(right.path));
  const artifactSha256 = artifactEntries.length > 0
    ? createHash('sha256')
        .update(JSON.stringify(artifactEntries), 'utf8')
        .digest('hex')
    : undefined;
  return {
    targetReferences: targets.length > 0
      ? targets
      : ['app/page.tsx', 'app/globals.css'],
    ...(artifactSha256 ? { artifactSha256 } : {}),
  };
}

function submittedArtifactReceipt(
  input: unknown,
  result: MoAgentToolResult,
): MoAgentToolContextReceipt {
  const data = resultData(result);
  const verified = isRecord(data) && Array.isArray(data.verifiedArtifacts)
    ? data.verifiedArtifacts
    : isRecord(input) && Array.isArray(input.artifacts)
      ? input.artifacts
      : [];
  return {
    targetReferences: verified
      .slice(0, 50)
      .filter((artifact): artifact is string => typeof artifact === 'string'),
  };
}

function imageReceipt(input: unknown, result: MoAgentToolResult): MoAgentToolContextReceipt {
  const data = resultData(result);
  const images = isRecord(data) && Array.isArray(data.images) ? data.images : [];
  const targets = images
    .slice(0, 32)
    .map((image) => stringField(image, 'path'))
    .filter((path): path is string => path !== undefined);
  const inputPath = stringField(input, 'path');
  if (targets.length === 0 && inputPath) targets.push(inputPath);
  return { targetReferences: targets };
}

/**
 * Returns a projector only for a known first-party tool contract. Each branch
 * reads an explicit, shallow field set; no arbitrary result traversal occurs.
 */
export function firstPartyContextReceiptProjector(
  toolName: string,
): ContextReceiptProjector | undefined {
  switch (toolName) {
    case 'list_files':
    case 'read_file':
    case 'read_file_range':
    case 'search_files':
    case 'query_json':
    case 'query_text_file':
      return (input, result) => pathReceipt(input, result);
    case 'write_file':
    case 'edit_file':
    case 'apply_patch':
      return (input, result) => pathReceipt(input, result, { digestKey: 'afterSha256' });
    case 'semantic_edit':
      return (input, result) => pathReceipt(input, result, { digestKey: 'afterSha256' });
    case 'inspect_dashboard_contract':
      return () => ({ targetReferences: DASHBOARD_CONTRACT_TARGETS });
    case 'apply_dashboard_spec':
      return (_input, result) => dashboardSpecReceipt(result);
    case 'quant_api_get':
      return (input) => {
        const apiPath = stringField(input, 'path');
        return { targetReferences: apiPath ? [apiPath] : [] };
      };
    case 'quant_extract_uploaded_image':
      return (input, result) => imageReceipt(input, result);
    case 'submit_result':
      return (input, result) => submittedArtifactReceipt(input, result);
    default:
      return undefined;
  }
}
