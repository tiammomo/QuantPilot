import { describe, expect, it } from 'vitest';

import {
  parsePersonalMemoryCandidate,
  personalMemoryCandidateEventId,
} from './PersonalMemoryCandidateCard';

describe('PersonalMemoryCandidateCard contract parser', () => {
  it('accepts the versioned bounded candidate contract', () => {
    expect(parsePersonalMemoryCandidate({
      contract: 'quantpilot-personal-memory-candidate/v1',
      key: 'output.answer_style',
      value: '以后先给结论',
      scope: 'project',
      reason: '稳定偏好',
    })).toMatchObject({ key: 'output.answer_style', scope: 'project' });
  });

  it('rejects unknown keys and unversioned metadata', () => {
    expect(parsePersonalMemoryCandidate({
      key: 'authorization.role',
      value: 'admin',
      scope: 'global',
      reason: 'unsafe',
    })).toBeNull();
  });

  it('derives a stable provider-safe idempotency key from the request ID', () => {
    expect(personalMemoryCandidateEventId('request/a?b')).toBe(
      'memory-candidate:request-a-b',
    );
  });
});
