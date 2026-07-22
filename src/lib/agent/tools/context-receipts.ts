import type {
  MoAgentTool,
  MoAgentToolContextReceipt,
  MoAgentToolResult,
} from '@/lib/agent/types';

type ContextReceiptProjector = NonNullable<MoAgentTool['projectContextReceipt']>;

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
    case 'submit_result':
      return (input, result) => submittedArtifactReceipt(input, result);
    default:
      return undefined;
  }
}
