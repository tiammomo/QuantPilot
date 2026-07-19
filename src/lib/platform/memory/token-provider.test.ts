import { describe, expect, it, vi } from 'vitest';

import {
  HttpMemoryAccessTokenBroker,
  StaticMemoryAccessTokenProvider,
} from './token-provider';

const broker = {
  url: 'https://identity.example/memory-token',
  clientId: 'quantpilot',
  clientSecret: 'test-client-secret-with-length',
  audience: 'evolvable-memory-api',
};

function tokenResponse(token: string): Response {
  return new Response(JSON.stringify({
    access_token: token,
    token_type: 'Bearer',
    expires_in: 300,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('personal memory access token providers', () => {
  it('uses a static token only for development-compatible configuration', async () => {
    const provider = new StaticMemoryAccessTokenProvider('development-token');
    await expect(provider.tokenFor({
      tenantId: 'tenant-a',
      subjectId: 'user-a',
      purpose: 'personalization',
    })).resolves.toBe('development-token');
  });

  it('requests and caches a token for one exact subject scope', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(tokenResponse('token-user-a'))
      .mockResolvedValueOnce(tokenResponse('token-user-b'));
    const provider = new HttpMemoryAccessTokenBroker(broker, 1_000, fetcher, () => 1_000);
    const scope = { tenantId: 'tenant-a', subjectId: 'user-a', purpose: 'personalization' };

    await expect(provider.tokenFor(scope, 'request-a')).resolves.toBe('token-user-a');
    await expect(provider.tokenFor(scope, 'request-b')).resolves.toBe('token-user-a');
    await expect(provider.tokenFor({ ...scope, subjectId: 'user-b' })).resolves.toBe('token-user-b');

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toMatch(/^Basic /);
    expect(JSON.parse(String(init.body))).toEqual({
      audience: 'evolvable-memory-api',
      tenant_id: 'tenant-a',
      subject_id: 'user-a',
      purpose: 'personalization',
      requested_role: 'subject_self',
    });
  });

  it('fails closed when the broker response is not a short-lived bearer token', async () => {
    const provider = new HttpMemoryAccessTokenBroker(
      broker,
      1_000,
      vi.fn().mockResolvedValue(new Response(JSON.stringify({
        access_token: 'token',
        token_type: 'Bearer',
        expires_in: 86_400,
      }), { status: 200 })),
    );

    await expect(provider.tokenFor({
      tenantId: 'tenant-a',
      subjectId: 'user-a',
      purpose: 'personalization',
    })).rejects.toMatchObject({ code: 'TOKEN_BROKER_INVALID_RESPONSE' });
  });
});
