import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  createServiceToken: vi.fn(),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/services/tokens', () => ({ createServiceToken: mocks.createServiceToken }));

import { AuthorizationError } from '@/lib/auth/authorization';
import { POST } from './route';

function request() {
  return new Request('http://localhost/api/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'github', token: 'secret-token', name: 'GitHub' }),
  }) as never;
}

describe('POST /api/tokens authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAction.mockResolvedValue({});
    mocks.createServiceToken.mockResolvedValue({ id: 'token-1', token: null });
  });

  it('requires the platform token-management capability before persisting a secret', async () => {
    const response = await POST(request());

    expect(response.status).toBe(201);
    expect(mocks.requireAction).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      action: 'platform.tokens.manage',
    });
    expect(mocks.requireAction.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.createServiceToken.mock.invocationCallOrder[0]);
  });

  it('does not persist a token after capability denial', async () => {
    mocks.requireAction.mockRejectedValueOnce(
      new AuthorizationError('CAPABILITY_DENIED', 403, '能力不足。'),
    );

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(mocks.createServiceToken).not.toHaveBeenCalled();
  });
});
