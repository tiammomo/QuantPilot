import { describe, expect, it, vi } from 'vitest';

import type { MemoryIntegrationConfig } from './config';
import type { PersonalMemoryControlRepository } from './control';
import {
  PersonalMemoryFeedbackConflictError,
  type PersonalMemoryFeedbackRepository,
} from './feedback-repository';
import type { PersonalMemoryPort } from './port';
import type {
  ExternalMemoryUseRecord,
  ExternalMemoryUseRepository,
} from './repository';
import {
  exposePersonalization,
  recallPersonalization,
  recordPersonalMemoryFeedback,
  rememberPersonalPreference,
} from './service';
import { MEMORY_HTTP_CONTRACT, MEMORY_PROVIDER_ID } from './types';

function runtimeConfig(required = false): MemoryIntegrationConfig {
  return {
    enabled: true,
    required,
    requireProductionReady: false,
    apiUrl: 'http://memory.test',
    tenantId: 'tenant-a',
    purpose: 'personalization',
    timeoutMs: 1_000,
    recallLimit: 6,
    maxProjectionCharacters: 2_000,
    bearerToken: null,
    tokenBroker: null,
    expectedContract: MEMORY_HTTP_CONTRACT,
  };
}

function port(overrides: Partial<PersonalMemoryPort> = {}): PersonalMemoryPort {
  const unavailable = vi.fn().mockRejectedValue(new Error('not implemented'));
  return {
    discover: vi.fn().mockResolvedValue({
      name: 'Memory',
      version: '0.1.0',
      apiContract: MEMORY_HTTP_CONTRACT,
      capabilities: [
        'preference.write',
        'preference.list',
        'preference.correct',
        'preference.history',
        'recall.trace',
        'recall.bitemporal',
        'recall.context-projection',
        'experience.outcome',
      ],
      authMode: 'development',
      scopeSource: 'request',
      productionReady: false,
      productionBlockers: ['identity.trusted-jwt'],
    }),
    checkReady: unavailable,
    listPreferences: vi.fn().mockResolvedValue([]),
    rememberPreference: unavailable,
    correctPreference: unavailable,
    getRevisions: unavailable,
    recall: unavailable,
    projectContext: unavailable,
    recordOutcome: unavailable,
    ...overrides,
  };
}

function uses(): ExternalMemoryUseRepository & {
  save: ReturnType<typeof vi.fn>;
  find: ReturnType<typeof vi.fn>;
  summarize: ReturnType<typeof vi.fn>;
} {
  return {
    save: vi.fn(async (value: ExternalMemoryUseRecord) => value),
    find: vi.fn().mockResolvedValue(null),
    summarize: vi.fn().mockResolvedValue({
      exposedRunCount: 0,
      exposedRevisionReferenceCount: 0,
      legacyEmptyAttributionCount: 0,
      lastExposedAt: null,
    }),
  };
}

function controls(enabled = true): PersonalMemoryControlRepository & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  const state = {
    configured: true,
    personalizationEnabled: enabled,
    policyVersion: 'quantpilot-personalization-v1',
    enabledAt: enabled ? new Date() : null,
    disabledAt: enabled ? null : new Date(),
    updatedAt: new Date(),
  };
  return {
    get: vi.fn().mockResolvedValue(state),
    set: vi.fn().mockResolvedValue({ ...state, changed: true }),
  };
}

function feedback(): PersonalMemoryFeedbackRepository & {
  begin: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
  summarize: ReturnType<typeof vi.fn>;
} {
  return {
    begin: vi.fn().mockResolvedValue({
      shouldSubmit: true,
      receipt: {
        id: 'receipt-a',
        provider: MEMORY_PROVIDER_ID,
        projectId: 'project-a',
        requestId: 'request-a',
        subjectId: 'user-a',
        revisionId: '00000000-0000-0000-0000-000000000003',
        eventId: 'feedback-1',
        kind: 'helpful',
        status: 'pending',
        outcomeId: null,
        lastErrorCode: null,
        completedAt: null,
      },
    }),
    complete: vi.fn().mockImplementation(async (_id: string, outcomeId: string) => ({
      id: 'receipt-a',
      provider: MEMORY_PROVIDER_ID,
      projectId: 'project-a',
      requestId: 'request-a',
      subjectId: 'user-a',
      revisionId: '00000000-0000-0000-0000-000000000003',
      eventId: 'feedback-1',
      kind: 'helpful',
      status: 'completed',
      outcomeId,
      lastErrorCode: null,
      completedAt: new Date(),
    })),
    fail: vi.fn().mockResolvedValue(undefined),
    summarize: vi.fn().mockResolvedValue({
      completedCount: 0,
      helpfulCount: 0,
      rejectedCount: 0,
      pendingCount: 0,
      failedCount: 0,
    }),
  };
}

describe('personal memory application service', () => {
  it('prepares filtered context and persists attribution only at actual exposure', async () => {
    const repository = uses();
    const memoryPort = port({
      recall: vi.fn().mockResolvedValue({
        traceId: '00000000-0000-0000-0000-000000000001',
        policyId: '00000000-0000-0000-0000-000000000002',
        policyVersion: 1,
        validAt: '2026-07-18T00:00:00Z',
        knownAt: '2026-07-18T00:00:00Z',
        createdAt: '2026-07-18T00:00:00Z',
        items: [],
      }),
      projectContext: vi.fn().mockResolvedValue({
        traceId: '00000000-0000-0000-0000-000000000001',
        policyId: '00000000-0000-0000-0000-000000000002',
        policyVersion: 1,
        content: '{}',
        sourceRevisionIds: ['00000000-0000-0000-0000-000000000003'],
        projectionSha256: 'a'.repeat(64),
        segments: [{
          content: JSON.stringify({
            context: { product: 'quantpilot' },
            key: 'output.detail_level',
            value: 'concise',
          }),
          sources: [{
            recordId: '00000000-0000-0000-0000-000000000004',
            revisionId: '00000000-0000-0000-0000-000000000003',
            rank: 1,
            score: 0.9,
          }],
        }],
      }),
    });

    const result = await recallPersonalization({
      projectId: 'project-a',
      actorUserId: 'user-a',
      requestId: 'request-a',
      instruction: '生成一个简洁的研究看板',
      capabilityId: 'stock_diagnosis',
    }, { config: runtimeConfig(), port: memoryPort, uses: repository, controls: controls() });

    expect(result).toMatchObject({ status: 'prepared', exposedMemoryCount: 1 });
    expect(result.capsule?.content).toContain('output.detail_level');
    expect(repository.save).not.toHaveBeenCalled();

    const exposed = await exposePersonalization({
      projectId: 'project-a',
      actorUserId: 'user-a',
      requestId: 'request-a',
      recall: result,
    }, { config: runtimeConfig(), port: memoryPort, uses: repository, controls: controls() });

    expect(exposed).toEqual(result.capsule);
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({
      provider: MEMORY_PROVIDER_ID,
      projectId: 'project-a',
      subjectId: 'user-a',
      exposedRevisionIds: ['00000000-0000-0000-0000-000000000003'],
    }));
    expect(memoryPort.recall).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a',
      subjectId: 'user-a',
      context: expect.objectContaining({ product: 'quantpilot', project_id: 'project-a' }),
    }), 'request-a');
  });

  it('degrades optional memory without failing the core request', async () => {
    const result = await recallPersonalization({
      projectId: 'project-a',
      actorUserId: 'user-a',
      requestId: 'request-a',
      instruction: '研究任务',
    }, {
      config: runtimeConfig(false),
      port: port({ recall: vi.fn().mockRejectedValue(new Error('offline')) }),
      uses: uses(),
      controls: controls(),
    });

    expect(result).toEqual({
      status: 'unavailable',
      capsule: null,
      exposedMemoryCount: 0,
      preparedUse: null,
    });
  });

  it('fails closed only when memory is explicitly required', async () => {
    await expect(recallPersonalization({
      projectId: 'project-a',
      actorUserId: 'user-a',
      requestId: 'request-a',
      instruction: '研究任务',
    }, {
      config: runtimeConfig(true),
      port: port({ recall: vi.fn().mockRejectedValue(new Error('offline')) }),
      uses: uses(),
      controls: controls(),
    })).rejects.toMatchObject({
      code: 'MEMORY_REQUIRED_UNAVAILABLE',
    });
  });

  it('constructs scope and idempotency keys server-side for explicit writes', async () => {
    const remember = vi.fn().mockResolvedValue({
      observationId: 'observation',
      candidateId: 'candidate',
      recordId: 'record',
      revisionId: 'revision',
      sequence: 1,
      idempotentReplay: false,
    });

    await rememberPersonalPreference({
      projectId: 'project-a',
      actorUserId: 'user-a',
      eventId: 'event-1',
      key: 'output.detail_level',
      value: 'concise',
      evidenceText: '用户明确要求简洁输出',
      scope: 'project',
      context: { product: 'forged' },
    }, {
      config: runtimeConfig(),
      port: port({ rememberPreference: remember }),
      uses: uses(),
      controls: controls(),
    });

    expect(remember).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a',
      subjectId: 'user-a',
      idempotencyKey: 'quantpilot:event-1:preference',
      context: { product: 'quantpilot', project_id: 'project-a' },
    }), 'event-1');
  });

  it('rejects control-plane keys as a client error before calling the provider', async () => {
    const remember = vi.fn();

    await expect(rememberPersonalPreference({
      projectId: 'project-a',
      actorUserId: 'user-a',
      eventId: 'event-2',
      key: 'authorization.role',
      value: 'admin',
      evidenceText: 'untrusted input',
    }, {
      config: runtimeConfig(),
      port: port({ rememberPreference: remember }),
      uses: uses(),
      controls: controls(),
    }))
      .rejects.toMatchObject({ code: 'INVALID_MEMORY_KEY', status: 400 });
    expect(remember).not.toHaveBeenCalled();
  });

  it('attributes feedback only to a revision exposed by the original trace', async () => {
    const repository = uses();
    repository.find.mockResolvedValue({
      provider: MEMORY_PROVIDER_ID,
      projectId: 'project-a',
      requestId: 'request-a',
      tenantId: 'tenant-a',
      subjectId: 'user-a',
      traceId: '00000000-0000-0000-0000-000000000001',
      policyId: '00000000-0000-0000-0000-000000000002',
      policyVersion: 1,
      validAt: new Date(),
      knownAt: new Date(),
      sourceProjectionSha256: 'a'.repeat(64),
      deliveredContextSha256: 'b'.repeat(64),
      exposedRevisionIds: ['00000000-0000-0000-0000-000000000003'],
    });
    const outcome = vi.fn().mockResolvedValue({ outcomeId: 'outcome', idempotentReplay: false });
    const feedbackRepository = feedback();

    await recordPersonalMemoryFeedback({
      projectId: 'project-a',
      actorUserId: 'user-a',
      requestId: 'request-a',
      revisionId: '00000000-0000-0000-0000-000000000003',
      eventId: 'feedback-1',
      kind: 'helpful',
    }, {
      config: runtimeConfig(),
      port: port({ recordOutcome: outcome }),
      uses: repository,
      controls: controls(),
      feedback: feedbackRepository,
    });

    expect(outcome).toHaveBeenCalledWith(expect.objectContaining({
      traceId: '00000000-0000-0000-0000-000000000001',
      revisionId: '00000000-0000-0000-0000-000000000003',
      idempotencyKey: 'quantpilot:feedback-1:outcome',
    }), 'feedback-1');
    expect(feedbackRepository.complete).toHaveBeenCalledWith('receipt-a', 'outcome');

    await expect(recordPersonalMemoryFeedback({
      projectId: 'project-a',
      actorUserId: 'user-a',
      requestId: 'request-a',
      revisionId: '00000000-0000-0000-0000-000000000099',
      eventId: 'feedback-2',
      kind: 'helpful',
    }, {
      config: runtimeConfig(),
      port: port({ recordOutcome: outcome }),
      uses: repository,
      controls: controls(),
      feedback: feedbackRepository,
    }))
      .rejects.toMatchObject({ code: 'MEMORY_REVISION_NOT_EXPOSED' });
  });

  it('replays a completed local feedback receipt without contacting the provider', async () => {
    const repository = uses();
    repository.find.mockResolvedValue({
      provider: MEMORY_PROVIDER_ID,
      projectId: 'project-a',
      requestId: 'request-a',
      tenantId: 'tenant-a',
      subjectId: 'user-a',
      traceId: '00000000-0000-0000-0000-000000000001',
      policyId: '00000000-0000-0000-0000-000000000002',
      policyVersion: 1,
      validAt: new Date(),
      knownAt: new Date(),
      sourceProjectionSha256: 'a'.repeat(64),
      deliveredContextSha256: 'b'.repeat(64),
      exposedRevisionIds: ['00000000-0000-0000-0000-000000000003'],
      status: 'exposed',
      exposedAt: new Date(),
    });
    const feedbackRepository = feedback();
    feedbackRepository.begin.mockResolvedValue({
      shouldSubmit: false,
      receipt: {
        id: 'receipt-a',
        provider: MEMORY_PROVIDER_ID,
        projectId: 'project-a',
        requestId: 'request-a',
        subjectId: 'user-a',
        revisionId: '00000000-0000-0000-0000-000000000003',
        eventId: 'feedback-1',
        kind: 'helpful',
        status: 'completed',
        outcomeId: '00000000-0000-0000-0000-000000000010',
        lastErrorCode: null,
        completedAt: new Date(),
      },
    });
    const outcome = vi.fn();

    await expect(recordPersonalMemoryFeedback({
      projectId: 'project-a',
      actorUserId: 'user-a',
      requestId: 'request-a',
      revisionId: '00000000-0000-0000-0000-000000000003',
      eventId: 'feedback-1',
      kind: 'helpful',
    }, {
      config: runtimeConfig(),
      port: port({ recordOutcome: outcome }),
      uses: repository,
      controls: controls(),
      feedback: feedbackRepository,
    })).resolves.toEqual({
      outcomeId: '00000000-0000-0000-0000-000000000010',
      idempotentReplay: true,
    });
    expect(outcome).not.toHaveBeenCalled();
  });

  it('rejects contradictory feedback for one exposed revision', async () => {
    const repository = uses();
    repository.find.mockResolvedValue({
      provider: MEMORY_PROVIDER_ID,
      projectId: 'project-a',
      requestId: 'request-a',
      tenantId: 'tenant-a',
      subjectId: 'user-a',
      traceId: '00000000-0000-0000-0000-000000000001',
      policyId: '00000000-0000-0000-0000-000000000002',
      policyVersion: 1,
      validAt: new Date(),
      knownAt: new Date(),
      sourceProjectionSha256: 'a'.repeat(64),
      deliveredContextSha256: 'b'.repeat(64),
      exposedRevisionIds: ['00000000-0000-0000-0000-000000000003'],
      status: 'exposed',
      exposedAt: new Date(),
    });
    const feedbackRepository = feedback();
    feedbackRepository.begin.mockRejectedValue(new PersonalMemoryFeedbackConflictError());

    await expect(recordPersonalMemoryFeedback({
      projectId: 'project-a',
      actorUserId: 'user-a',
      requestId: 'request-a',
      revisionId: '00000000-0000-0000-0000-000000000003',
      eventId: 'feedback-2',
      kind: 'rejected',
    }, {
      config: runtimeConfig(),
      port: port(),
      uses: repository,
      controls: controls(),
      feedback: feedbackRepository,
    })).rejects.toMatchObject({ code: 'MEMORY_FEEDBACK_CONFLICT', status: 409 });
  });

  it('marks provider failure durably and retries with the same idempotency key', async () => {
    const repository = uses();
    repository.find.mockResolvedValue({
      provider: MEMORY_PROVIDER_ID,
      projectId: 'project-a',
      requestId: 'request-a',
      tenantId: 'tenant-a',
      subjectId: 'user-a',
      traceId: '00000000-0000-0000-0000-000000000001',
      policyId: '00000000-0000-0000-0000-000000000002',
      policyVersion: 1,
      validAt: new Date(),
      knownAt: new Date(),
      sourceProjectionSha256: 'a'.repeat(64),
      deliveredContextSha256: 'b'.repeat(64),
      exposedRevisionIds: ['00000000-0000-0000-0000-000000000003'],
      status: 'exposed',
      exposedAt: new Date(),
    });
    const feedbackRepository = feedback();
    const outcome = vi.fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce({
        outcomeId: '00000000-0000-0000-0000-000000000010',
        idempotentReplay: true,
      });
    const input = {
      projectId: 'project-a',
      actorUserId: 'user-a',
      requestId: 'request-a',
      revisionId: '00000000-0000-0000-0000-000000000003',
      eventId: 'feedback-1',
      kind: 'helpful' as const,
    };
    const overrides = {
      config: runtimeConfig(),
      port: port({ recordOutcome: outcome }),
      uses: repository,
      controls: controls(),
      feedback: feedbackRepository,
    };

    await expect(recordPersonalMemoryFeedback(input, overrides)).rejects.toThrow('provider unavailable');
    expect(feedbackRepository.fail).toHaveBeenCalledWith('receipt-a', 'INTEGRATION_ERROR');

    await expect(recordPersonalMemoryFeedback(input, overrides)).resolves.toMatchObject({
      outcomeId: '00000000-0000-0000-0000-000000000010',
    });
    expect(outcome).toHaveBeenCalledTimes(2);
    for (const call of outcome.mock.calls) {
      expect(call[0]).toMatchObject({ idempotencyKey: 'quantpilot:feedback-1:outcome' });
    }
    expect(feedbackRepository.complete).toHaveBeenCalledWith(
      'receipt-a',
      '00000000-0000-0000-0000-000000000010',
    );
  });

  it('does not contact the provider when the user has disabled personalization', async () => {
    const memoryPort = port();

    const result = await recallPersonalization({
      projectId: 'project-a',
      actorUserId: 'user-a',
      requestId: 'request-opted-out',
      instruction: '研究任务',
    }, {
      config: runtimeConfig(),
      port: memoryPort,
      uses: uses(),
      controls: controls(false),
    });

    expect(result).toEqual({
      status: 'opted_out',
      capsule: null,
      exposedMemoryCount: 0,
      preparedUse: null,
    });
    expect(memoryPort.discover).not.toHaveBeenCalled();
    expect(memoryPort.recall).not.toHaveBeenCalled();
  });

  it('rechecks the user control before exposing a completed projection', async () => {
    const repository = uses();
    const control = controls();
    control.get
      .mockResolvedValueOnce({
        configured: true,
        personalizationEnabled: true,
        policyVersion: 'quantpilot-personalization-v1',
        enabledAt: new Date(),
        disabledAt: null,
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        configured: true,
        personalizationEnabled: false,
        policyVersion: 'quantpilot-personalization-v1',
        enabledAt: null,
        disabledAt: new Date(),
        updatedAt: new Date(),
      });
    const memoryPort = port({
      recall: vi.fn().mockResolvedValue({
        traceId: '00000000-0000-0000-0000-000000000001',
        policyId: '00000000-0000-0000-0000-000000000002',
        policyVersion: 1,
        validAt: '2026-07-18T00:00:00Z',
        knownAt: '2026-07-18T00:00:00Z',
        createdAt: '2026-07-18T00:00:00Z',
        items: [],
      }),
      projectContext: vi.fn().mockResolvedValue({
        traceId: '00000000-0000-0000-0000-000000000001',
        policyId: '00000000-0000-0000-0000-000000000002',
        policyVersion: 1,
        content: '{}',
        sourceRevisionIds: [],
        projectionSha256: 'a'.repeat(64),
        segments: [],
      }),
    });

    const result = await recallPersonalization({
      projectId: 'project-a',
      actorUserId: 'user-a',
      requestId: 'request-revoked',
      instruction: '研究任务',
    }, {
      config: runtimeConfig(),
      port: memoryPort,
      uses: repository,
      controls: control,
    });

    expect(result.status).toBe('opted_out');
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('does not expose a prepared capsule when the user revokes consent before agent use', async () => {
    const repository = uses();
    const control = controls();
    control.get
      .mockResolvedValueOnce({
        configured: true,
        personalizationEnabled: true,
        policyVersion: 'quantpilot-personalization-v1',
        enabledAt: new Date(),
        disabledAt: null,
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        configured: true,
        personalizationEnabled: true,
        policyVersion: 'quantpilot-personalization-v1',
        enabledAt: new Date(),
        disabledAt: null,
        updatedAt: new Date(),
      })
      .mockResolvedValueOnce({
        configured: true,
        personalizationEnabled: false,
        policyVersion: 'quantpilot-personalization-v1',
        enabledAt: null,
        disabledAt: new Date(),
        updatedAt: new Date(),
      });
    const memoryPort = port({
      recall: vi.fn().mockResolvedValue({
        traceId: '00000000-0000-0000-0000-000000000001',
        policyId: '00000000-0000-0000-0000-000000000002',
        policyVersion: 1,
        validAt: '2026-07-18T00:00:00Z',
        knownAt: '2026-07-18T00:00:00Z',
        createdAt: '2026-07-18T00:00:00Z',
        items: [],
      }),
      projectContext: vi.fn().mockResolvedValue({
        traceId: '00000000-0000-0000-0000-000000000001',
        policyId: '00000000-0000-0000-0000-000000000002',
        policyVersion: 1,
        content: '{}',
        sourceRevisionIds: ['00000000-0000-0000-0000-000000000003'],
        projectionSha256: 'a'.repeat(64),
        segments: [{
          content: JSON.stringify({
            context: { product: 'quantpilot' },
            key: 'output.detail_level',
            value: 'concise',
          }),
          sources: [{
            recordId: '00000000-0000-0000-0000-000000000004',
            revisionId: '00000000-0000-0000-0000-000000000003',
            rank: 1,
            score: 0.9,
          }],
        }],
      }),
    });
    const recalled = await recallPersonalization({
      projectId: 'project-a',
      actorUserId: 'user-a',
      requestId: 'request-revoked-after-prepare',
      instruction: '研究任务',
    }, {
      config: runtimeConfig(),
      port: memoryPort,
      uses: repository,
      controls: control,
    });

    const exposed = await exposePersonalization({
      projectId: 'project-a',
      actorUserId: 'user-a',
      requestId: 'request-revoked-after-prepare',
      recall: recalled,
    }, {
      config: runtimeConfig(),
      port: memoryPort,
      uses: repository,
      controls: control,
    });

    expect(recalled.status).toBe('prepared');
    expect(exposed).toBeNull();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('does not expose optional memory when durable attribution cannot be saved', async () => {
    const repository = uses();
    repository.save.mockRejectedValue(new Error('database unavailable'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const recalled = {
      status: 'prepared' as const,
      exposedMemoryCount: 1,
      capsule: {
        content: '{"memories":[]}',
        traceId: '00000000-0000-0000-0000-000000000001',
        revisionIds: ['00000000-0000-0000-0000-000000000003'],
        sourceProjectionSha256: 'a'.repeat(64),
        contentSha256: 'b'.repeat(64),
      },
      preparedUse: {
        tenantId: 'tenant-a',
        subjectId: 'user-a',
        traceId: '00000000-0000-0000-0000-000000000001',
        policyId: '00000000-0000-0000-0000-000000000002',
        policyVersion: 1,
        validAt: '2026-07-18T00:00:00Z',
        knownAt: '2026-07-18T00:00:00Z',
        sourceProjectionSha256: 'a'.repeat(64),
        deliveredContextSha256: 'b'.repeat(64),
        exposedRevisionIds: ['00000000-0000-0000-0000-000000000003'],
      },
    };

    const exposed = await exposePersonalization({
      projectId: 'project-a',
      actorUserId: 'user-a',
      requestId: 'request-attribution-failed',
      recall: recalled,
    }, {
      config: runtimeConfig(false),
      port: port(),
      uses: repository,
      controls: controls(),
    });

    expect(exposed).toBeNull();
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });
});
