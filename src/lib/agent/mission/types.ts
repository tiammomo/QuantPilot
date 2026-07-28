export const PI_AGENT_MISSION_STATUSES = [
  'running',
  'candidate_complete',
  'verifying',
  'repair_required',
  'repairing',
  'completed',
  'failed',
  'cancelled',
] as const;

export type PiAgentMissionStatus = (typeof PI_AGENT_MISSION_STATUSES)[number];

export const PI_AGENT_MISSION_NODE_KEYS = [
  'planning',
  'data_prefetch',
  'workspace_generation',
  'validation',
  'evidence_verification',
  'preview_readiness',
] as const;

export type PiAgentMissionNodeKey = (typeof PI_AGENT_MISSION_NODE_KEYS)[number];

export type PiAgentMissionNodeStatus =
  | 'pending'
  | 'running'
  | 'candidate_complete'
  | 'passed'
  | 'failed'
  | 'skipped';

export type PiAgentMissionNodeEffect =
  | 'pure'
  | 'read'
  | 'workspace_write'
  | 'platform_write'
  | 'verification';

export type PiAgentArtifactRole = 'subject' | 'evidence' | 'control';
export type PiAgentArtifactMutability = 'frozen' | 'derived' | 'mutable';

export interface PiAgentArtifactRequirement {
  path: string;
  role: PiAgentArtifactRole;
  mutability: PiAgentArtifactMutability;
  required: boolean;
}

export interface PiAgentAcceptancePredicate {
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

export interface PiAgentMissionNodeBudget {
  maxAttempts: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface PiAgentMissionNodeSpec {
  key: PiAgentMissionNodeKey;
  type: 'planner' | 'data' | 'writer' | 'validator' | 'verifier' | 'preview';
  effect: PiAgentMissionNodeEffect;
  dependencies: PiAgentMissionNodeKey[];
  allowedTools: string[];
  requiredSkillSections: string[];
  inputArtifacts: string[];
  outputArtifacts: string[];
  budget: PiAgentMissionNodeBudget;
  acceptancePredicates: string[];
}

/**
 * Trusted product/domain projection used to compile a MissionSpec. PI Agent
 * owns lifecycle semantics, while applications own artifacts, validation
 * checks, node tools and delivery acceptance rules.
 */
export interface PiAgentMissionDefinition {
  id: string;
  version: string;
  validationReportPath: string;
  artifacts: PiAgentArtifactRequirement[];
  requiredValidationCheckIds: string[];
  allowedValidationWarnings: string[];
  nodes: PiAgentMissionNodeSpec[];
  acceptancePredicates: PiAgentAcceptancePredicate[];
}

export interface PiAgentMissionCompositionRef {
  profileId: string;
  profileVersion: string;
  domainPacks: Array<{ id: string; version: string }>;
  deliveryPackId: string;
  deliveryPackVersion: string;
  compositionSha256: string;
}

export interface PiAgentExpectedEntityRef {
  entityType: string;
  canonicalId: string;
}

export interface PiAgentMissionSpec {
  schemaVersion: 1;
  framework: 'PI Agent';
  projectId: string;
  requestId: string;
  objectiveSha256: string;
  composition: PiAgentMissionCompositionRef;
  capabilityId: string;
  runPlanId: string;
  validationReportPath: string;
  expectedEntities: PiAgentExpectedEntityRef[];
  artifacts: PiAgentArtifactRequirement[];
  requiredValidationCheckIds: string[];
  allowedValidationWarnings: string[];
  maxRepairAttempts: number;
  nodes: PiAgentMissionNodeSpec[];
  acceptancePredicates: PiAgentAcceptancePredicate[];
  createdAt: string;
}

export interface PiAgentMissionHandle {
  id: string;
  generationId: string;
  projectId: string;
  requestId: string;
  status: PiAgentMissionStatus;
  version: number;
  candidateVersion: number;
  specHash: string;
  acceptedReceiptId: string | null;
}

/** Capability required for every write performed by a verification owner. */
export interface PiAgentMissionVerificationFence {
  leaseOwner: string;
  fencingToken: number;
}

/** Durable claim returned after a candidate's verification lease is acquired. */
export interface PiAgentMissionVerificationClaim
  extends PiAgentMissionVerificationFence {
  mission: PiAgentMissionHandle;
  leaseExpiresAt: string;
}

export type PiAgentCandidateSource =
  | 'pi_agent_submit_result'
  | 'platform_prefetch'
  | 'workspace_recovery'
  | 'platform_repair'
  | 'platform_template_recovery';

/** Safe candidate projection returned by an execution stage. */
export interface PiAgentCandidateSubmission {
  schemaVersion: 1;
  source: PiAgentCandidateSource;
  sourceRunId: string | null;
  sourceRequestId: string;
  workspaceSha256: string;
  summarySha256: string;
  declaredArtifacts: string[];
  verifiedArtifacts: string[];
  submittedAt: string;
}

export type PiAgentEvidenceVerdict =
  | 'candidate_complete'
  | 'accepted'
  | 'repair_required'
  | 'retry_infrastructure'
  | 'stale'
  | 'rejected'
  | 'cancelled';

export interface PiAgentEvidenceReceiptHandle {
  id: string;
  missionId: string;
  generationId: string;
  candidateVersion: number;
  receiptType: 'candidate' | 'validation' | 'acceptance';
  verdict: PiAgentEvidenceVerdict;
  subjectHash: string;
  receiptHash: string;
  createdAt: string;
}

export interface PiAgentAcceptedMissionSnapshot {
  missionId: string;
  generationId: string;
  projectId: string;
  requestId: string;
  missionStatus: PiAgentMissionStatus;
  candidateVersion: number;
  acceptedReceiptId: string | null;
  acceptedReceiptHash: string | null;
  acceptedAt: string | null;
  previewUrl: string | null;
  previewPort: number | null;
}
