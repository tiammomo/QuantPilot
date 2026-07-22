import type {
  MoAgentArtifactRequirement,
  MoAgentMissionDefinition,
  MoAgentMissionNodeBudget,
  MoAgentMissionNodeSpec,
} from './types';

function budget(overrides: Partial<MoAgentMissionNodeBudget> = {}): MoAgentMissionNodeBudget {
  return {
    maxAttempts: 1,
    maxToolCalls: 0,
    maxInputTokens: 0,
    maxOutputTokens: 0,
    timeoutMs: 30_000,
    ...overrides,
  };
}

function classify(path: string): MoAgentArtifactRequirement {
  if (path === '.data-agent/state.json') {
    return { path, role: 'control', mutability: 'mutable', required: true };
  }
  if ([
    '.data-agent/validation.json',
    '.data-agent/visual-validation.json',
    '.data-agent/artifact-contracts.json',
  ].includes(path)) {
    return { path, role: 'evidence', mutability: 'derived', required: true };
  }
  return { path, role: 'subject', mutability: 'frozen', required: true };
}

export function createTestMissionDefinition(input: {
  maxRepairAttempts: number;
  expectedArtifacts?: readonly string[];
}): MoAgentMissionDefinition {
  const artifacts = new Map<string, MoAgentArtifactRequirement>();
  for (const path of [
    'app/page.tsx',
    'evidence/sources.json',
    '.data-agent/validation.json',
    '.data-agent/visual-validation.json',
    '.data-agent/artifact-contracts.json',
    '.data-agent/state.json',
    ...(input.expectedArtifacts ?? []),
  ]) artifacts.set(path, classify(path));
  for (const artifact of [
    { path: 'components/**', role: 'subject', mutability: 'frozen', required: false },
    { path: 'data/final/**', role: 'subject', mutability: 'frozen', required: false },
    { path: 'evidence/**', role: 'evidence', mutability: 'derived', required: false },
    { path: 'next.config.*', role: 'subject', mutability: 'frozen', required: false },
    { path: 'package-lock.json', role: 'subject', mutability: 'frozen', required: false },
  ] as const) artifacts.set(artifact.path, artifact);

  const nodes: MoAgentMissionNodeSpec[] = [
    {
      key: 'planning', type: 'planner', effect: 'platform_write', dependencies: [],
      allowedTools: [], requiredSkillSections: ['run-planner'], inputArtifacts: [],
      outputArtifacts: ['.data-agent/task.json'], budget: budget(),
      acceptancePredicates: ['plan_ready'],
    },
    {
      key: 'data_prefetch', type: 'data', effect: 'platform_write', dependencies: ['planning'],
      allowedTools: [], requiredSkillSections: ['data-quality'],
      inputArtifacts: ['.data-agent/task.json'], outputArtifacts: ['data/final/result.json'],
      budget: budget(), acceptancePredicates: ['data_ready'],
    },
    {
      key: 'workspace_generation', type: 'writer', effect: 'workspace_write',
      dependencies: ['data_prefetch'], allowedTools: ['submit_result'],
      requiredSkillSections: ['dashboard-visualization'], inputArtifacts: ['data/final/result.json'],
      outputArtifacts: ['app/page.tsx'],
      budget: budget({ maxAttempts: 1 + input.maxRepairAttempts, maxToolCalls: 4 }),
      acceptancePredicates: ['candidate_submission'],
    },
    {
      key: 'validation', type: 'validator', effect: 'verification',
      dependencies: ['workspace_generation'], allowedTools: [], requiredSkillSections: [],
      inputArtifacts: ['app/page.tsx'], outputArtifacts: ['.data-agent/validation.json'],
      budget: budget({ maxAttempts: 1 + input.maxRepairAttempts }),
      acceptancePredicates: ['required_validation_checks'],
    },
    {
      key: 'preview_readiness', type: 'preview', effect: 'verification',
      dependencies: ['validation'], allowedTools: [], requiredSkillSections: [],
      inputArtifacts: ['app/page.tsx'], outputArtifacts: [], budget: budget(),
      acceptancePredicates: ['preview_http_ready'],
    },
    {
      key: 'evidence_verification', type: 'verifier', effect: 'verification',
      dependencies: ['validation', 'preview_readiness'], allowedTools: [],
      requiredSkillSections: [], inputArtifacts: ['.data-agent/validation.json'],
      outputArtifacts: [], budget: budget(),
      acceptancePredicates: ['subject_manifest_stable', 'preview_http_ready'],
    },
  ];

  return {
    id: 'test.data-workspace',
    version: '1.0.0',
    validationReportPath: '.data-agent/validation.json',
    artifacts: [...artifacts.values()],
    requiredValidationCheckIds: ['next_build', 'visual_presentation', 'evidence_files'],
    allowedValidationWarnings: ['evidence_files'],
    nodes,
    acceptancePredicates: [
      { id: 'candidate_submission', kind: 'candidate_submission', required: true },
      { id: 'required_validation_checks', kind: 'required_validation_checks', required: true },
      { id: 'subject_manifest_stable', kind: 'subject_manifest_stable', required: true },
      { id: 'preview_http_ready', kind: 'preview_http_ready', required: true },
    ],
  };
}
