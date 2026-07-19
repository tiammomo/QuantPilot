import type {
  CorrectPreferenceInput,
  MemoryOutcomeResult,
  MemoryPreferenceSummary,
  MemoryProjectionResult,
  MemoryRecallResult,
  MemoryRevision,
  MemoryServiceInfo,
  MemoryWriteResult,
  ProjectMemoryInput,
  RecallMemoryInput,
  RecordMemoryOutcomeInput,
  RememberPreferenceInput,
} from './types';

export interface PersonalMemoryPort {
  discover(requestId?: string): Promise<MemoryServiceInfo>;
  checkReady(requestId?: string): Promise<void>;
  listPreferences(
    scope: { tenantId: string; subjectId: string; purpose: string },
    requestId?: string,
  ): Promise<MemoryPreferenceSummary[]>;
  rememberPreference(input: RememberPreferenceInput, requestId?: string): Promise<MemoryWriteResult>;
  correctPreference(input: CorrectPreferenceInput, requestId?: string): Promise<MemoryWriteResult>;
  getRevisions(
    scope: { tenantId: string; subjectId: string; purpose: string; recordId: string },
    requestId?: string,
  ): Promise<MemoryRevision[]>;
  recall(input: RecallMemoryInput, requestId?: string): Promise<MemoryRecallResult>;
  projectContext(input: ProjectMemoryInput, requestId?: string): Promise<MemoryProjectionResult>;
  recordOutcome(input: RecordMemoryOutcomeInput, requestId?: string): Promise<MemoryOutcomeResult>;
}
