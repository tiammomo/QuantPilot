import { createHash } from 'node:crypto';

import type {
  MoAgentTool,
  MoAgentToolContextReceipt,
  MoAgentToolResult,
} from '@/lib/agent/types';

type Projector = NonNullable<MoAgentTool['projectContextReceipt']>;

const CONTRACT_TARGETS = [
  '.data-agent/task.json',
  '.data-agent/plan.json',
  '.data-agent/finance-query-rewrite.json',
  '.data-agent/finance-run-plan.json',
  'data_file/final/dashboard-data.json',
  'evidence/sources.json',
  'evidence/data_quality.json',
  'app/page.tsx',
  'app/globals.css',
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: unknown, key: string): string | undefined {
  const data = record(value);
  return typeof data?.[key] === 'string' ? data[key] as string : undefined;
}

function dashboardReceipt(result: MoAgentToolResult): MoAgentToolContextReceipt {
  const data = result.ok ? record(result.data) : null;
  const files = Array.isArray(data?.files) ? data.files.slice(0, 16) : [];
  const targets = files
    .map((file) => stringField(file, 'path'))
    .filter((path): path is string => Boolean(path));
  const entries = files.map((file) => ({
    path: stringField(file, 'path'),
    afterSha256: stringField(file, 'afterSha256'),
  })).filter((file): file is { path: string; afterSha256: string } =>
    Boolean(file.path && file.afterSha256))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    targetReferences: targets.length ? targets : ['app/page.tsx', 'app/globals.css'],
    ...(entries.length
      ? {
          artifactSha256: createHash('sha256')
            .update(JSON.stringify(entries), 'utf8')
            .digest('hex'),
        }
      : {}),
  };
}

function imageReceipt(input: unknown, result: MoAgentToolResult): MoAgentToolContextReceipt {
  const data = result.ok ? record(result.data) : null;
  const images = Array.isArray(data?.images) ? data.images.slice(0, 32) : [];
  const targets = images
    .map((image) => stringField(image, 'path'))
    .filter((path): path is string => Boolean(path));
  const inputPath = stringField(input, 'path');
  if (!targets.length && inputPath) targets.push(inputPath);
  return { targetReferences: targets };
}

export function financeContextReceiptProjector(toolName: string): Projector | undefined {
  switch (toolName) {
    case 'inspect_dashboard_contract':
      return () => ({ targetReferences: [...CONTRACT_TARGETS] });
    case 'apply_dashboard_spec':
      return (_input, result) => dashboardReceipt(result);
    case 'quant_api_get':
      return (input) => {
        const path = stringField(input, 'path');
        return { targetReferences: path ? [path] : [] };
      };
    case 'quant_extract_uploaded_image':
      return (input, result) => imageReceipt(input, result);
    default:
      return undefined;
  }
}
