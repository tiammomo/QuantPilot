import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAuthSession } from '@/lib/auth/access';
import { proxy } from './proxy';

vi.mock('@/lib/auth/access', () => ({ getAuthSession: vi.fn() }));

const originalMode = process.env.QUANTPILOT_AUTH_MODE;
const originalSecret = process.env.QUANTPILOT_AUTH_SECRET;

function request(path: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`http://localhost:3000${path}`, init);
}

describe('project authentication proxy', () => {
  beforeEach(() => {
    vi.mocked(getAuthSession).mockReset();
    process.env.QUANTPILOT_AUTH_MODE = 'local';
    process.env.QUANTPILOT_AUTH_SECRET = 'test-secret-that-is-longer-than-thirty-two-characters';
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.QUANTPILOT_AUTH_MODE;
    else process.env.QUANTPILOT_AUTH_MODE = originalMode;
    if (originalSecret === undefined) delete process.env.QUANTPILOT_AUTH_SECRET;
    else process.env.QUANTPILOT_AUTH_SECRET = originalSecret;
  });

  it('keeps the existing anonymous workflow when auth is disabled', async () => {
    process.env.QUANTPILOT_AUTH_MODE = 'disabled';
    const response = await proxy(request('/api/projects'));
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(getAuthSession).not.toHaveBeenCalled();
  });

  it('redirects anonymous page requests to login and preserves a local next path', async () => {
    vi.mocked(getAuthSession).mockResolvedValue(null);
    const response = await proxy(request('/strategy-platform?tab=factors'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?next=%2Fstrategy-platform%3Ftab%3Dfactors',
    );
  });

  it('returns a structured 401 for anonymous API requests', async () => {
    vi.mocked(getAuthSession).mockResolvedValue(null);
    const response = await proxy(request('/api/projects'));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'AUTHENTICATION_REQUIRED' });
  });

  it('does not exempt project asset APIs just because the path has a file extension', async () => {
    vi.mocked(getAuthSession).mockResolvedValue(null);
    const response = await proxy(request('/api/assets/project-1/private-chart.png'));
    expect(response.status).toBe(401);
  });

  it('allows only the minimal public liveness path without a session', async () => {
    const response = await proxy(request('/api/health'));
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(getAuthSession).not.toHaveBeenCalled();
  });

  it('protects detailed infrastructure health data', async () => {
    vi.mocked(getAuthSession).mockResolvedValue(null);
    const response = await proxy(request('/api/infrastructure/health'));
    expect(response.status).toBe(401);
  });

  it('lets authenticated members reach capability-protected platform handlers', async () => {
    vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'user-1', role: 'member' } } as never);
    const response = await proxy(request('/api/tokens', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
    }));
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('still rejects anonymous callers before capability-protected handlers', async () => {
    vi.mocked(getAuthSession).mockResolvedValue(null);
    const response = await proxy(request('/api/tokens', { method: 'POST' }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'AUTHENTICATION_REQUIRED' });
  });

  it('keeps absolute administration routes fail-closed for members', async () => {
    vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'user-1', role: 'member' } } as never);
    const response = await proxy(request('/api/admin/users'));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'ADMIN_REQUIRED' });
  });

  it('rejects authenticated cross-origin mutations', async () => {
    vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'user-1' } } as never);
    const response = await proxy(request('/api/projects', {
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'INVALID_REQUEST_ORIGIN' });
  });

  it('allows authenticated same-origin mutations', async () => {
    vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'user-1' } } as never);
    const response = await proxy(request('/api/projects', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
    }));
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('accepts the actual host origin when Next normalizes nextUrl differently', async () => {
    vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'user-1' } } as never);
    const response = await proxy(request('/api/projects', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3000',
        origin: 'http://127.0.0.1:3000',
      },
    }));
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
