import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireAction: vi.fn(), getOpsPlatformDashboard: vi.fn() }));
vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/ops/ops-platform', () => ({ getOpsPlatformDashboard: mocks.getOpsPlatformDashboard }));

import { AuthorizationError } from '@/lib/auth/authorization';
import { GET } from './route';

describe('GET /api/ops/platform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAction.mockResolvedValue({});
    mocks.getOpsPlatformDashboard.mockResolvedValue({ productHealth: { available: false, error: '指标降级' } });
  });

  it.each([['', false], ['?includeLogs=1', true], ['?includeLogs=true', false]])(
    'returns a private dashboard and requires explicit log inclusion: %s', async (query, includeLogEntries) => {
      const request = new Request(`http://localhost/api/ops/platform${query}`);
      const response = await GET(request);

      expect(mocks.requireAction).toHaveBeenCalledWith({ headers: request.headers, action: 'platform.observability.read' });
      expect(mocks.getOpsPlatformDashboard).toHaveBeenCalledWith({ includeLogEntries });
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      await expect(response.json()).resolves.toMatchObject({
        success: true,
        data: { productHealth: { available: false, error: '指标降级' } },
      });
    },
  );

  it.each([401, 403] as const)('never collects product metrics for an unauthorized caller (%i)', async (status) => {
    mocks.requireAction.mockRejectedValue(new AuthorizationError('FORBIDDEN', status, '无权访问。'));
    const response = await GET(new Request('http://localhost/api/ops/platform'));

    expect(response.status).toBe(status);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.getOpsPlatformDashboard).not.toHaveBeenCalled();
  });

  it('does not expose infrastructure credentials or cache errors', async () => {
    mocks.getOpsPlatformDashboard.mockRejectedValue(new Error('postgresql://user:password@private-host/db'));
    const response = await GET(new Request('http://localhost/api/ops/platform'));

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.text()).not.toMatch(/password|private-host/);
  });
});
