import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  ApiIdempotencyConflictError,
  claimApiOperation,
  cleanupExpiredApiOperations,
  completeApiOperation,
  failApiOperation,
  normalizeIdempotencyKey,
} from './api-idempotency';

function transactionClient(transaction: Record<string, unknown>) {
  return {
    $transaction: vi.fn(async (callback: (value: unknown) => unknown) => callback(transaction)),
  } as never;
}

function operationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'operation-1',
    scope: 'test-scope',
    actorKey: 'user-1',
    idempotencyKeyHash: 'key-hash',
    payloadHash: 'payload-hash',
    status: 'running',
    attempt: 1,
    leaseExpiresAt: new Date('2026-07-17T01:00:00.000Z'),
    responseStatus: null,
    responseBody: null,
    responseBytes: null,
    errorCode: null,
    errorMessage: null,
    completedAt: null,
    retentionExpiresAt: new Date('2026-07-24T00:00:00.000Z'),
    createdAt: new Date('2026-07-17T00:00:00.000Z'),
    updatedAt: new Date('2026-07-17T00:00:00.000Z'),
    ...overrides,
  };
}

describe('API idempotency ledger', () => {
  it('keeps raw and hashed normalization domains disjoint', () => {
    const longKey = 'x'.repeat(600);
    const normalizedLongKey = normalizeIdempotencyKey(longKey);
    expect(normalizedLongKey).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(normalizeIdempotencyKey(normalizedLongKey)).toBe(`raw:${normalizedLongKey}`);
    expect(normalizeIdempotencyKey('client-key')).toBe('raw:client-key');
  });

  it('hashes canonical payloads and returns a durable acquired claim', async () => {
    const create = vi.fn(async ({ data }) => operationRow({
      idempotencyKeyHash: data.idempotencyKeyHash,
      payloadHash: data.payloadHash,
    }));
    const transaction = {
      $queryRaw: vi.fn(),
      apiIdempotencyOperation: {
        findUnique: vi.fn().mockResolvedValue(null),
        create,
      },
    };
    const first = await claimApiOperation({
      scope: 'test-scope',
      actorKey: 'user-1',
      idempotencyKey: 'request-1',
      payload: { nested: { b: 2, a: 1 }, enabled: true },
      now: new Date('2026-07-17T00:00:00.000Z'),
      client: transactionClient(transaction),
    });
    const firstHash = create.mock.calls[0][0].data.payloadHash;

    create.mockClear();
    const second = await claimApiOperation({
      scope: 'test-scope',
      actorKey: 'user-1',
      idempotencyKey: 'request-1',
      payload: { enabled: true, nested: { a: 1, b: 2 } },
      now: new Date('2026-07-17T00:00:00.000Z'),
      client: transactionClient(transaction),
    });

    expect(first.state).toBe('acquired');
    expect(second.state).toBe('acquired');
    expect(create.mock.calls[0][0].data.payloadHash).toBe(firstHash);
  });

  it('replays a completed response and rejects payload drift', async () => {
    const createdData: Record<string, unknown> = {};
    const bootstrapTransaction = {
      $queryRaw: vi.fn(),
      apiIdempotencyOperation: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }) => {
          Object.assign(createdData, data);
          return operationRow(data);
        }),
      },
    };
    await claimApiOperation({
      scope: 'test-scope',
      actorKey: 'user-1',
      idempotencyKey: 'request-1',
      payload: { symbol: '600519' },
      now: new Date('2026-07-17T00:00:00.000Z'),
      client: transactionClient(bootstrapTransaction),
    });

    const completed = operationRow({
      ...createdData,
      status: 'completed',
      responseStatus: 201,
      responseBody: { success: true, data: { id: 'result-1' } },
    });
    const replayTransaction = {
      $queryRaw: vi.fn(),
      apiIdempotencyOperation: { findUnique: vi.fn().mockResolvedValue(completed) },
    };
    const replay = await claimApiOperation({
      scope: 'test-scope',
      actorKey: 'user-1',
      idempotencyKey: 'request-1',
      payload: { symbol: '600519' },
      now: new Date('2026-07-17T00:10:00.000Z'),
      client: transactionClient(replayTransaction),
    });
    expect(replay).toMatchObject({
      state: 'completed',
      responseStatus: 201,
      responseAvailable: true,
      responseBody: { success: true, data: { id: 'result-1' } },
    });

    await expect(claimApiOperation({
      scope: 'test-scope',
      actorKey: 'user-1',
      idempotencyKey: 'request-1',
      payload: { symbol: '000001' },
      now: new Date('2026-07-17T00:10:00.000Z'),
      client: transactionClient(replayTransaction),
    })).rejects.toBeInstanceOf(ApiIdempotencyConflictError);
  });

  it('allows a failed operation to retry with a new fenced attempt', async () => {
    const createdData: Record<string, unknown> = {};
    const bootstrap = {
      $queryRaw: vi.fn(),
      apiIdempotencyOperation: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }) => {
          Object.assign(createdData, data);
          return operationRow(data);
        }),
      },
    };
    const first = await claimApiOperation({
      scope: 'test-scope', actorKey: 'user-1', idempotencyKey: 'retry-1', payload: { action: 'run' },
      now: new Date('2026-07-17T00:00:00.000Z'), client: transactionClient(bootstrap),
    });
    expect(first.state).toBe('acquired');

    const failedRow = operationRow({ ...createdData, status: 'failed' });
    const retryTransaction = {
      $queryRaw: vi.fn(),
      apiIdempotencyOperation: {
        findUnique: vi.fn().mockResolvedValue(failedRow),
        update: vi.fn().mockResolvedValue(operationRow({ ...createdData, status: 'running', attempt: 2 })),
      },
    };
    const retry = await claimApiOperation({
      scope: 'test-scope', actorKey: 'user-1', idempotencyKey: 'retry-1', payload: { action: 'run' },
      now: new Date('2026-07-17T00:10:00.000Z'), client: transactionClient(retryTransaction),
    });
    expect(retry).toMatchObject({ state: 'acquired', handle: { attempt: 2 } });
  });

  it('does not recycle an expired completed key while quota accounting is pending', async () => {
    const payloadHashCapture: Record<string, unknown> = {};
    const bootstrap = {
      $queryRaw: vi.fn(),
      apiIdempotencyOperation: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }) => {
          Object.assign(payloadHashCapture, data);
          return operationRow(data);
        }),
      },
    };
    await claimApiOperation({
      scope: 'test-scope', actorKey: 'user-1', idempotencyKey: 'pending-1', payload: { action: 'run' },
      now: new Date('2026-07-17T00:00:00.000Z'), client: transactionClient(bootstrap),
    });
    const update = vi.fn();
    const transaction = {
      $queryRaw: vi.fn(),
      apiIdempotencyOperation: {
        findUnique: vi.fn().mockResolvedValue(operationRow({
          ...payloadHashCapture,
          status: 'completed',
          retentionExpiresAt: new Date('2026-07-17T00:01:00.000Z'),
          responseStatus: 200,
          responseBody: { success: true },
          quotaSettlement: { reservationId: 'reservation-1' },
          quotaAccountedAt: null,
        })),
        update,
      },
    };

    const replay = await claimApiOperation({
      scope: 'test-scope', actorKey: 'user-1', idempotencyKey: 'pending-1', payload: { action: 'run' },
      now: new Date('2026-07-18T00:00:00.000Z'), client: transactionClient(transaction),
    });

    expect(replay.state).toBe('completed');
    expect(update).not.toHaveBeenCalled();
  });

  it('fences terminal writes and omits oversized responses from replay storage', async () => {
    const completeUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const completed = await completeApiOperation({
      handle: { id: 'operation-1', attempt: 2, payloadHash: 'payload-hash' },
      responseStatus: 200,
      responseBody: { value: 'x'.repeat(513 * 1024) },
      client: transactionClient({
        apiIdempotencyOperation: { updateMany: completeUpdate },
      }),
    });
    expect(completed.responseAvailable).toBe(false);
    expect(completeUpdate.mock.calls[0][0].data.responseBody).toBe(Prisma.DbNull);

    const failUpdate = vi.fn().mockResolvedValue({ count: 1 });
    await expect(failApiOperation({
      handle: { id: 'operation-1', attempt: 2, payloadHash: 'payload-hash' },
      error: new Error('known failure'),
      client: transactionClient({ apiIdempotencyOperation: { updateMany: failUpdate } }),
    })).resolves.toBe(true);
    expect(failUpdate.mock.calls[0][0].where).toMatchObject({ attempt: 2, status: 'running' });
  });

  it('cleans terminal and abandoned records only after retention expires', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 3 });
    await expect(cleanupExpiredApiOperations({
      now: new Date('2026-07-24T00:00:00.000Z'),
      client: { apiIdempotencyOperation: { deleteMany } } as never,
    })).resolves.toBe(3);
    expect(deleteMany).toHaveBeenCalledWith({ where: { OR: expect.any(Array) } });
  });
});
