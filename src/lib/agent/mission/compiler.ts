import { createHash } from 'node:crypto';
import type {
  MoAgentArtifactMutability,
  MoAgentArtifactRequirement,
  MoAgentArtifactRole,
  MoAgentMissionNodeBudget,
  MoAgentMissionNodeSpec,
  MoAgentMissionSpec,
} from './types';

export const MOAGENT_REQUIRED_VALIDATION_CHECK_IDS = [
  'artifact_policy',
  'next_build',
  'preview_http_200',
  'visual_presentation',
  'final_data_file',
  'evidence_files',
  'artifact_contracts',
  'dashboard_data_binding',
  'chart_presence',
  'market_proxy',
] as const;

export const MOAGENT_ALLOWED_VALIDATION_WARNINGS = [
  'evidence_files',
] as const;

const SUBJECT_ARTIFACTS = [
  '.quantpilot/query_rewrite.json',
  '.quantpilot/run_plan.json',
  'app/page.tsx',
  'app/globals.css',
  'app/layout.tsx',
  'app/api/market/[...path]/route.ts',
  'package.json',
  'data_file/final/dashboard-data.json',
  'evidence/sources.json',
  'evidence/data_quality.json',
] as const;

/**
 * Platform-owned acceptance surfaces. These patterns are deliberately not
 * configurable by the Agent: they extend the exact required artifact contract
 * to every source/configuration file that can affect the rendered dashboard.
 */
const OPTIONAL_SUBJECT_ARTIFACTS = [
  'components/**',
  'lib/**',
  'src/**',
  'scripts/**',
  'public/**',
  'data_file/final/**',
  'next.config.*',
  'postcss.config.*',
  'tailwind.config.*',
  'tsconfig.json',
  'tsconfig.*.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'components.json',
] as const;

const OPTIONAL_EVIDENCE_ARTIFACTS = ['evidence/**'] as const;

const EVIDENCE_ARTIFACTS = new Set([
  '.quantpilot/validation.json',
  '.quantpilot/visual-validation.json',
  '.quantpilot/artifact-contracts.json',
]);

const CONTROL_ARTIFACTS = new Set([
  '.quantpilot/generation-state.json',
  '.quantpilot/generation-queue.json',
  '.quantpilot/events.jsonl',
]);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedIdentifier(value: string, label: string, max = 256): string {
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > max) {
    throw new Error(`${label} must be between 1 and ${max} UTF-8 bytes.`);
  }
  return normalized;
}

function safeArtifactPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    /[*?[\]]/.test(normalized) ||
    normalized.split('/').includes('..') ||
    Buffer.byteLength(normalized, 'utf8') > 1_024
  ) {
    throw new Error(`Invalid MissionSpec artifact path: ${value}`);
  }
  return normalized;
}

function artifactClassification(path: string): {
  role: MoAgentArtifactRole;
  mutability: MoAgentArtifactMutability;
} {
  if (CONTROL_ARTIFACTS.has(path)) return { role: 'control', mutability: 'mutable' };
  if (EVIDENCE_ARTIFACTS.has(path) || path.startsWith('.quantpilot/screenshots/')) {
    return { role: 'evidence', mutability: 'derived' };
  }
  return { role: 'subject', mutability: 'frozen' };
}

function compileArtifacts(expectedArtifacts: readonly string[]): MoAgentArtifactRequirement[] {
  const artifacts = new Map<string, MoAgentArtifactRequirement>();
  const add = (
    artifactPath: string,
    required: boolean,
    classification = artifactClassification(artifactPath),
  ) => {
    const existing = artifacts.get(artifactPath);
    if (existing?.required && !required) return;
    artifacts.set(artifactPath, { path: artifactPath, ...classification, required });
  };

  for (const artifact of SUBJECT_ARTIFACTS) add(artifact, true);
  for (const artifact of expectedArtifacts) add(safeArtifactPath(artifact), true);
  for (const artifact of EVIDENCE_ARTIFACTS) add(artifact, true);
  for (const artifact of CONTROL_ARTIFACTS) add(artifact, true);
  for (const artifact of OPTIONAL_SUBJECT_ARTIFACTS) {
    add(artifact, false, { role: 'subject', mutability: 'frozen' });
  }
  for (const artifact of OPTIONAL_EVIDENCE_ARTIFACTS) {
    add(artifact, false, { role: 'evidence', mutability: 'derived' });
  }

  return [...artifacts.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function budget(overrides: Partial<MoAgentMissionNodeBudget>): MoAgentMissionNodeBudget {
  return {
    maxAttempts: 1,
    maxToolCalls: 0,
    maxInputTokens: 0,
    maxOutputTokens: 0,
    timeoutMs: 120_000,
    ...overrides,
  };
}

function compileNodes(maxRepairAttempts: number): MoAgentMissionNodeSpec[] {
  return [
    {
      key: 'planning',
      type: 'planner',
      effect: 'platform_write',
      dependencies: [],
      allowedTools: [],
      requiredSkillSections: ['query-rewrite', 'run-planner'],
      inputArtifacts: ['.quantpilot/query_rewrite.json'],
      outputArtifacts: ['.quantpilot/run_plan.json'],
      budget: budget({ timeoutMs: 120_000 }),
      acceptancePredicates: ['run_plan_created'],
    },
    {
      key: 'data_prefetch',
      type: 'data',
      effect: 'platform_write',
      dependencies: ['planning'],
      allowedTools: [],
      requiredSkillSections: ['query-rewrite', 'quant-market-data', 'data-quality'],
      inputArtifacts: ['.quantpilot/query_rewrite.json', '.quantpilot/run_plan.json'],
      outputArtifacts: [
        'data_file/final/dashboard-data.json',
        'evidence/sources.json',
        'evidence/data_quality.json',
      ],
      budget: budget({ timeoutMs: 180_000 }),
      acceptancePredicates: ['prefetched_artifacts_present'],
    },
    {
      key: 'workspace_generation',
      type: 'writer',
      effect: 'workspace_write',
      dependencies: ['data_prefetch'],
      allowedTools: [
        'inspect_dashboard_contract',
        'query_json',
        'query_text_file',
        'apply_dashboard_spec',
        'semantic_edit',
        'write_file',
        'edit_file',
        'apply_patch',
        'submit_result',
      ],
      requiredSkillSections: ['dashboard-visualization'],
      inputArtifacts: [
        '.quantpilot/query_rewrite.json',
        '.quantpilot/run_plan.json',
        'data_file/final/dashboard-data.json',
        'evidence/sources.json',
        'evidence/data_quality.json',
      ],
      outputArtifacts: ['app/page.tsx', 'app/globals.css'],
      budget: budget({
        maxAttempts: 1 + maxRepairAttempts,
        maxToolCalls: 20,
        maxInputTokens: 160_000,
        maxOutputTokens: 24_000,
        timeoutMs: 1_200_000,
      }),
      acceptancePredicates: ['candidate_submission'],
    },
    {
      key: 'validation',
      type: 'validator',
      effect: 'verification',
      dependencies: ['workspace_generation'],
      allowedTools: [],
      requiredSkillSections: [],
      inputArtifacts: ['app/page.tsx', 'app/globals.css'],
      outputArtifacts: [
        '.quantpilot/validation.json',
        '.quantpilot/visual-validation.json',
        '.quantpilot/artifact-contracts.json',
      ],
      budget: budget({ maxAttempts: 1 + maxRepairAttempts, timeoutMs: 600_000 }),
      acceptancePredicates: ['required_validation_checks'],
    },
    {
      key: 'preview_readiness',
      type: 'preview',
      effect: 'verification',
      dependencies: ['validation'],
      allowedTools: [],
      requiredSkillSections: [],
      inputArtifacts: ['app/page.tsx'],
      outputArtifacts: [],
      budget: budget({ maxAttempts: 2, timeoutMs: 120_000 }),
      acceptancePredicates: ['preview_http_ready'],
    },
    {
      key: 'evidence_verification',
      type: 'verifier',
      effect: 'verification',
      dependencies: ['validation', 'preview_readiness'],
      allowedTools: [],
      requiredSkillSections: [],
      inputArtifacts: [
        '.quantpilot/validation.json',
        '.quantpilot/visual-validation.json',
        '.quantpilot/artifact-contracts.json',
      ],
      outputArtifacts: [],
      budget: budget({ maxAttempts: 1 + maxRepairAttempts, timeoutMs: 60_000 }),
      acceptancePredicates: [
        'subject_manifest_stable',
        'derived_evidence_present',
        'preview_http_ready',
      ],
    },
  ];
}

export function compileMoAgentMissionSpec(input: {
  projectId: string;
  requestId: string;
  objective: string;
  capabilityId: string;
  runPlanId: string;
  symbols?: readonly string[];
  expectedArtifacts?: readonly string[];
  maxRepairAttempts: number;
  createdAt?: string;
}): MoAgentMissionSpec {
  if (!Number.isSafeInteger(input.maxRepairAttempts) || input.maxRepairAttempts < 0) {
    throw new Error('maxRepairAttempts must be a non-negative safe integer.');
  }
  const objective = input.objective.trim();
  if (!objective) throw new Error('Mission objective cannot be empty.');
  return {
    schemaVersion: 1,
    framework: 'MoAgent',
    projectId: boundedIdentifier(input.projectId, 'projectId'),
    requestId: boundedIdentifier(input.requestId, 'requestId'),
    objectiveSha256: `sha256:${sha256(objective)}`,
    capabilityId: boundedIdentifier(input.capabilityId, 'capabilityId'),
    runPlanId: boundedIdentifier(input.runPlanId, 'runPlanId'),
    expectedSymbols: [...new Set(
      (input.symbols ?? []).map((symbol) => boundedIdentifier(symbol, 'symbol', 64)),
    )].sort(),
    artifacts: compileArtifacts(input.expectedArtifacts ?? []),
    requiredValidationCheckIds: [...MOAGENT_REQUIRED_VALIDATION_CHECK_IDS],
    allowedValidationWarnings: [...MOAGENT_ALLOWED_VALIDATION_WARNINGS],
    maxRepairAttempts: input.maxRepairAttempts,
    nodes: compileNodes(input.maxRepairAttempts),
    acceptancePredicates: [
      { id: 'candidate_submission', kind: 'candidate_submission', required: true },
      {
        id: 'required_validation_checks',
        kind: 'required_validation_checks',
        required: true,
        parameters: { checkIds: [...MOAGENT_REQUIRED_VALIDATION_CHECK_IDS] },
      },
      { id: 'subject_manifest_stable', kind: 'subject_manifest_stable', required: true },
      { id: 'derived_evidence_present', kind: 'derived_evidence_present', required: true },
      { id: 'preview_http_ready', kind: 'preview_http_ready', required: true },
    ],
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
