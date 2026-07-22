import type {
  MoAgentArtifactMutability,
  MoAgentArtifactRequirement,
  MoAgentArtifactRole,
  MoAgentMissionDefinition,
  MoAgentMissionNodeBudget,
  MoAgentMissionNodeSpec,
} from '@/lib/agent/mission';

export const FINANCE_REQUIRED_VALIDATION_CHECK_IDS = [
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

export const FINANCE_ALLOWED_VALIDATION_WARNINGS = ['evidence_files'] as const;

const SUBJECT_ARTIFACTS = [
  '.data-agent/workspace.json',
  '.data-agent/profile.json',
  '.data-agent/task.json',
  '.data-agent/plan.json',
  '.data-agent/finance-query-rewrite.json',
  '.data-agent/finance-run-plan.json',
  'app/page.tsx',
  'app/globals.css',
  'app/layout.tsx',
  'app/api/market/[...path]/route.ts',
  'package.json',
  'data_file/final/dashboard-data.json',
  'evidence/sources.json',
  'evidence/data_quality.json',
] as const;

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

const EVIDENCE_ARTIFACTS = [
  '.data-agent/validation.json',
  '.data-agent/visual-validation.json',
  '.data-agent/artifact-contracts.json',
] as const;

const CONTROL_ARTIFACTS = [
  '.data-agent/generation-state.json',
  '.data-agent/generation-queue.json',
  '.data-agent/events.jsonl',
] as const;

function classification(path: string): {
  role: MoAgentArtifactRole;
  mutability: MoAgentArtifactMutability;
} {
  if ((CONTROL_ARTIFACTS as readonly string[]).includes(path)) {
    return { role: 'control', mutability: 'mutable' };
  }
  if (
    (EVIDENCE_ARTIFACTS as readonly string[]).includes(path) ||
    path.startsWith('.data-agent/screenshots/')
  ) {
    return { role: 'evidence', mutability: 'derived' };
  }
  return { role: 'subject', mutability: 'frozen' };
}

function artifacts(expectedArtifacts: readonly string[]): MoAgentArtifactRequirement[] {
  const result = new Map<string, MoAgentArtifactRequirement>();
  const add = (
    path: string,
    required: boolean,
    kind = classification(path),
  ) => {
    const existing = result.get(path);
    if (existing?.required && !required) return;
    result.set(path, { path, ...kind, required });
  };
  for (const path of SUBJECT_ARTIFACTS) add(path, true);
  for (const path of expectedArtifacts) add(path, true);
  for (const path of EVIDENCE_ARTIFACTS) add(path, true);
  for (const path of CONTROL_ARTIFACTS) add(path, true);
  for (const path of OPTIONAL_SUBJECT_ARTIFACTS) add(path, false);
  add('evidence/**', false, { role: 'evidence', mutability: 'derived' });
  return [...result.values()];
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

function nodes(maxRepairAttempts: number): MoAgentMissionNodeSpec[] {
  return [
    {
      key: 'planning',
      type: 'planner',
      effect: 'platform_write',
      dependencies: [],
      allowedTools: [],
      requiredSkillSections: ['query-rewrite', 'run-planner'],
      inputArtifacts: ['.data-agent/finance-query-rewrite.json'],
      outputArtifacts: [
        '.data-agent/task.json',
        '.data-agent/plan.json',
        '.data-agent/finance-run-plan.json',
      ],
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
      inputArtifacts: [
        '.data-agent/task.json',
        '.data-agent/plan.json',
        '.data-agent/finance-query-rewrite.json',
        '.data-agent/finance-run-plan.json',
      ],
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
        '.data-agent/finance-query-rewrite.json',
        '.data-agent/finance-run-plan.json',
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
        '.data-agent/validation.json',
        '.data-agent/visual-validation.json',
        '.data-agent/artifact-contracts.json',
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
        '.data-agent/validation.json',
        '.data-agent/visual-validation.json',
        '.data-agent/artifact-contracts.json',
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

export function createFinanceMissionDefinition(input: {
  maxRepairAttempts: number;
  expectedArtifacts?: readonly string[];
}): MoAgentMissionDefinition {
  return {
    id: 'finance.quant-workspace',
    version: '1.0.0',
    validationReportPath: '.data-agent/validation.json',
    artifacts: artifacts(input.expectedArtifacts ?? []),
    requiredValidationCheckIds: [...FINANCE_REQUIRED_VALIDATION_CHECK_IDS],
    allowedValidationWarnings: [...FINANCE_ALLOWED_VALIDATION_WARNINGS],
    nodes: nodes(input.maxRepairAttempts),
    acceptancePredicates: [
      { id: 'candidate_submission', kind: 'candidate_submission', required: true },
      {
        id: 'required_validation_checks',
        kind: 'required_validation_checks',
        required: true,
        parameters: { checkIds: [...FINANCE_REQUIRED_VALIDATION_CHECK_IDS] },
      },
      { id: 'subject_manifest_stable', kind: 'subject_manifest_stable', required: true },
      { id: 'derived_evidence_present', kind: 'derived_evidence_present', required: true },
      { id: 'preview_http_ready', kind: 'preview_http_ready', required: true },
    ],
  };
}
