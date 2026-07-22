export const MOAGENT_MISSION_STATUSES = [
  'running',
  'candidate_complete',
  'verifying',
  'repair_required',
  'repairing',
  'completed',
  'failed',
  'cancelled',
] as const;

export type MoAgentMissionStatus = (typeof MOAGENT_MISSION_STATUSES)[number];

export const MOAGENT_MISSION_NODE_KEYS = [
  'planning',
  'data_prefetch',
  'workspace_generation',
  'validation',
  'evidence_verification',
  'preview_readiness',
] as const;

export type MoAgentMissionNodeKey = (typeof MOAGENT_MISSION_NODE_KEYS)[number];

export type MoAgentMissionNodeStatus =
  | 'pending'
  | 'running'
  | 'candidate_complete'
  | 'passed'
  | 'failed'
  | 'skipped';

export type MoAgentMissionNodeEffect =
  | 'pure'
  | 'read'
  | 'workspace_write'
  | 'platform_write'
  | 'verification';

export type MoAgentArtifactRole = 'subject' | 'evidence' | 'control';
export type MoAgentArtifactMutability = 'frozen' | 'derived' | 'mutable';

export interface MoAgentArtifactRequirement {
  path: string;
  role: MoAgentArtifactRole;
  mutability: MoAgentArtifactMutability;
  required: boolean;
}

export interface MoAgentAcceptancePredicate {
  id: string;
  kind:
    | 'candidate_submission'
    | 'required_validation_checks'
    | 'subject_manifest_stable'
    | 'derived_evidence_present'
    | 'preview_http_ready';
  required: boolean;
  parameters?: Record<string, string | number | boolean | string[]>;
}

export interface MoAgentMissionNodeBudget {
  maxAttempts: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface MoAgentMissionNodeSpec {
  key: MoAgentMissionNodeKey;
  type: 'planner' | 'data' | 'writer' | 'validator' | 'verifier' | 'preview';
  effect: MoAgentMissionNodeEffect;
  dependencies: MoAgentMissionNodeKey[];
  allowedTools: string[];
  requiredSkillSections: string[];
  inputArtifacts: string[];
  outputArtifacts: string[];
  budget: MoAgentMissionNodeBudget;
  acceptancePredicates: string[];
}

/**
 * Trusted product/domain projection used to compile a MissionSpec. MoAgent
 * owns lifecycle semantics, while applications own artifacts, validation
 * checks, node tools and delivery acceptance rules.
 */
export interface MoAgentMissionDefinition {
  id: string;
  version: string;
  validationReportPath: string;
  artifacts: MoAgentArtifactRequirement[];
  requiredValidationCheckIds: string[];
  allowedValidationWarnings: string[];
  nodes: MoAgentMissionNodeSpec[];
  acceptancePredicates: MoAgentAcceptancePredicate[];
}

export interface MoAgentMissionCompositionRef {
  profileId: string;
  profileVersion: string;
  domainPackIds: string[];
  deliveryPackId: string;
}

export interface MoAgentExpectedEntityRef {
  entityType: string;
  canonicalId: string;
}

export interface MoAgentMissionSpec {
  schemaVersion: 1;
  framework: 'MoAgent';
  projectId: string;
  requestId: string;
  objectiveSha256: string;
  composition: MoAgentMissionCompositionRef;
  capabilityId: string;
  runPlanId: string;
  validationReportPath: string;
  expectedEntities: MoAgentExpectedEntityRef[];
  artifacts: MoAgentArtifactRequirement[];
  requiredValidationCheckIds: string[];
  allowedValidationWarnings: string[];
  maxRepairAttempts: number;
  nodes: MoAgentMissionNodeSpec[];
  acceptancePredicates: MoAgentAcceptancePredicate[];
  createdAt: string;
}

export interface MoAgentMissionHandle {
  id: string;
  generationId: string;
  projectId: string;
  requestId: string;
  status: MoAgentMissionStatus;
  version: number;
  candidateVersion: number;
  specHash: string;
  acceptedReceiptId: string | null;
}

/** Capability required for every write performed by a verification owner. */
export interface MoAgentMissionVerificationFence {
  leaseOwner: string;
  fencingToken: number;
}

/** Durable claim returned after a candidate's verification lease is acquired. */
export interface MoAgentMissionVerificationClaim
  extends MoAgentMissionVerificationFence {
  mission: MoAgentMissionHandle;
  leaseExpiresAt: string;
}

export type MoAgentCandidateSource =
  | 'moagent_submit_result'
  | 'platform_prefetch'
  | 'workspace_recovery'
  | 'platform_repair'
  | 'platform_template_recovery';

/** Safe candidate projection returned by an execution stage. */
export interface MoAgentCandidateSubmission {
  schemaVersion: 1;
  source: MoAgentCandidateSource;
  sourceRunId: string | null;
  sourceRequestId: string;
  workspaceSha256: string;
  summarySha256: string;
  declaredArtifacts: string[];
  verifiedArtifacts: string[];
  submittedAt: string;
}

export type MoAgentEvidenceVerdict =
  | 'candidate_complete'
  | 'accepted'
  | 'repair_required'
  | 'retry_infrastructure'
  | 'stale'
  | 'rejected'
  | 'cancelled';

export interface MoAgentEvidenceReceiptHandle {
  id: string;
  missionId: string;
  generationId: string;
  candidateVersion: number;
  receiptType: 'candidate' | 'validation' | 'acceptance';
  verdict: MoAgentEvidenceVerdict;
  subjectHash: string;
  receiptHash: string;
  createdAt: string;
}

export interface MoAgentAcceptedMissionSnapshot {
  missionId: string;
  generationId: string;
  projectId: string;
  requestId: string;
  missionStatus: MoAgentMissionStatus;
  candidateVersion: number;
  acceptedReceiptId: string | null;
  acceptedReceiptHash: string | null;
  acceptedAt: string | null;
  previewUrl: string | null;
  previewPort: number | null;
}
