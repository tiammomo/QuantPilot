import fs from 'node:fs/promises';
import type { MoAgentTool } from '@/lib/agent/types';
import { MoAgentToolError, throwIfAborted } from './errors';
import { inputRecord, optionalString, requiredString } from './input';
import { MoAgentWorkspacePolicy } from './path-policy';
import { DEFAULT_TOOL_TIMEOUT_MS, executeMoAgentTool } from './runtime';

export interface SubmitResultInput {
  summary: string;
  artifacts: string[];
  notes?: string;
}

export interface SubmitResultOutput extends SubmitResultInput {
  candidateStatus: 'candidate_complete';
  verifiedArtifacts: string[];
}

export interface MoAgentSubmitResultToolOptions {
  workspaceRoot: string;
  timeoutMs?: number;
}

function parseSubmitResultInput(value: unknown): SubmitResultInput {
  const record = inputRecord(value);
  let artifacts: string[] = [];
  if (record.artifacts !== undefined) {
    if (!Array.isArray(record.artifacts) || record.artifacts.length > 50 ||
      !record.artifacts.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 1_024)) {
      throw new MoAgentToolError('INVALID_TOOL_INPUT', 'artifacts must be an array of at most 50 workspace-relative paths.');
    }
    artifacts = [...new Set(record.artifacts as string[])];
  }
  const notes = record.notes === undefined
    ? undefined
    : optionalString(record, 'notes', '', { allowEmpty: true, maxLength: 8_000 });
  return {
    summary: requiredString(record, 'summary', { maxLength: 8_000 }),
    artifacts,
    ...(notes === undefined ? {} : { notes }),
  };
}

export function createSubmitResultTool(options: MoAgentSubmitResultToolOptions): MoAgentTool<SubmitResultInput, SubmitResultOutput> {
  let policyPromise: Promise<MoAgentWorkspacePolicy> | undefined;
  const policy = () => policyPromise ??= MoAgentWorkspacePolicy.create({ workspaceRoot: options.workspaceRoot });
  return {
    name: 'submit_result',
    description: 'Submit a candidate result for independent platform verification. Every declared artifact is verified inside the workspace. A successful call ends only this physical Agent run; it does not complete the product Mission.',
    effect: 'pure',
    idempotency: 'intrinsic',
    terminal: true,
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Concise description of completed work.' },
        artifacts: { type: 'array', maxItems: 50, items: { type: 'string' }, description: 'Workspace-relative output files.' },
        notes: { type: 'string' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    parseInput: parseSubmitResultInput,
    execute: (input, context) => executeMoAgentTool(context.signal, options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS, async (signal) => {
      const workspacePolicy = await policy();
      const verifiedArtifacts: string[] = [];
      for (const artifact of input.artifacts) {
        throwIfAborted(signal);
        const resolved = await workspacePolicy.resolveReadPath(artifact);
        if (!(await fs.stat(resolved.canonicalPath)).isFile()) {
          throw new MoAgentToolError('NOT_A_FILE', `Submitted artifact is not a file: ${resolved.relativePath}.`);
        }
        verifiedArtifacts.push(resolved.relativePath);
      }
      const data: SubmitResultOutput = {
        ...input,
        candidateStatus: 'candidate_complete',
        verifiedArtifacts,
      };
      return {
        ok: true,
        data,
        content: `Candidate submitted for platform verification: ${input.summary}${verifiedArtifacts.length ? `\nArtifacts: ${verifiedArtifacts.join(', ')}` : ''}`,
      };
    }),
  };
}
