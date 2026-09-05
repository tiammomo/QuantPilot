import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  getResolvedServiceCatalog: vi.fn(),
  validateServiceCatalog: vi.fn(),
  buildServiceDependencyEdges: vi.fn(),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/platform/service-catalog', () => ({
  getResolvedServiceCatalog: mocks.getResolvedServiceCatalog,
  validateServiceCatalog: mocks.validateServiceCatalog,
  buildServiceDependencyEdges: mocks.buildServiceDependencyEdges,
}));

import { AuthorizationError } from '@/lib/auth/authorization';
import { GET } from './route';

const request = new NextRequest('http://localhost/api/infrastructure/service-catalog');

describe('GET /api/infrastructure/service-catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAction.mockResolvedValue({ session: { user: { id: 'admin-a' } } });
    mocks.getResolvedServiceCatalog.mockReturnValue([{ id: 'web' }, { id: 'database' }]);
    mocks.validateServiceCatalog.mockReturnValue({ ok: true, errors: [], warnings: [] });
    mocks.buildServiceDependencyEdges.mockReturnValue([{ from: 'web', to: 'database' }]);
  });

  it('authorizes before returning the resolved dependency graph', async () => {
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.requireAction).toHaveBeenCalledWith({
      headers: request.headers,
      action: 'platform.observability.read',
    });
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { version: 1, services: [{ id: 'web' }, { id: 'database' }] },
    });
  });

  it('does not resolve catalog data when authorization fails', async () => {
    mocks.requireAction.mockRejectedValue(
      new AuthorizationError('FORBIDDEN', 403, '无权查看服务目录。'),
    );

    const response = await GET(request);

    expect(response.status).toBe(403);
    expect(mocks.getResolvedServiceCatalog).not.toHaveBeenCalled();
  });
});
