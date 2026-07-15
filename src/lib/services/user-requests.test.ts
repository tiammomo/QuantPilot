import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transactionClient = {
    userRequest: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  };
  const userRequest = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  };
  return {
    transactionClient,
    userRequest,
    transaction: vi.fn(async (callback: (tx: typeof transactionClient) => unknown) =>
      callback(transactionClient)
    ),
  };
});

vi.mock('@/lib/db/client', () => ({
  prisma: {
    $transaction: mocks.transaction,
    userRequest: mocks.userRequest,
  },
}));

import {
  assertUserRequestProjectBinding,
  isUserRequestCancelled,
  markUserRequestAsCancelled,
  markUserRequestAsRunning,
  upsertUserRequest,
  UserRequestProjectMismatchError,
} from './user-requests';

describe('upsertUserRequest project scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a client request ID already owned by another project before mutation', async () => {
    mocks.transactionClient.userRequest.findUnique.mockResolvedValue({ projectId: 'project-b' });

    await expect(upsertUserRequest({
      id: 'request-1',
      projectId: 'project-a',
      instruction: 'do not overwrite project b',
    })).rejects.toBeInstanceOf(UserRequestProjectMismatchError);

    expect(mocks.transactionClient.userRequest.update).not.toHaveBeenCalled();
    expect(mocks.transactionClient.userRequest.create).not.toHaveBeenCalled();
  });

  it('updates an existing request only when it belongs to the same project', async () => {
    mocks.transactionClient.userRequest.findUnique.mockResolvedValue({ projectId: 'project-a' });
    mocks.transactionClient.userRequest.update.mockResolvedValue({ id: 'request-1' });

    await upsertUserRequest({
      id: 'request-1',
      projectId: 'project-a',
      instruction: 'updated instruction',
      cliPreference: 'moagent',
    });

    expect(mocks.transactionClient.userRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { instruction: 'updated instruction', cliPreference: 'moagent' },
    });
  });

  it('rejects an existing cross-project binding at the read-only ingress guard', async () => {
    mocks.userRequest.findUnique.mockResolvedValue({ projectId: 'project-b' });

    await expect(
      assertUserRequestProjectBinding('project-a', 'request-1'),
    ).rejects.toBeInstanceOf(UserRequestProjectMismatchError);
  });

  it('allows an unclaimed request ID to proceed to the transactional upsert', async () => {
    mocks.userRequest.findUnique.mockResolvedValue(null);

    await expect(
      assertUserRequestProjectBinding('project-a', 'request-new'),
    ).resolves.toBe(false);
  });

  it('scopes state transitions by both project ID and request ID', async () => {
    mocks.userRequest.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      markUserRequestAsRunning('project-a', 'request-1'),
    ).resolves.toBe(true);
    await expect(
      markUserRequestAsCancelled('project-a', 'request-1', 'stop'),
    ).resolves.toBe(true);

    expect(mocks.userRequest.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'request-1',
        projectId: 'project-a',
        status: { in: ['pending', 'processing', 'active', 'running'] },
      },
      data: expect.objectContaining({ status: 'running' }),
    });
    expect(mocks.userRequest.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'request-1',
        projectId: 'project-a',
        status: { in: ['pending', 'processing', 'active', 'running'] },
      },
      data: expect.objectContaining({ status: 'cancelled', errorMessage: 'stop' }),
    });
  });

  it('checks cancellation only inside the expected project', async () => {
    mocks.userRequest.findFirst.mockResolvedValue({ status: 'cancelled' });

    await expect(
      isUserRequestCancelled('project-a', 'request-1'),
    ).resolves.toBe(true);
    expect(mocks.userRequest.findFirst).toHaveBeenCalledWith({
      where: { id: 'request-1', projectId: 'project-a' },
      select: { status: true },
    });
  });
});
