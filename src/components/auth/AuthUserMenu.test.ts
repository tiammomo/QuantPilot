import { describe, expect, it } from 'vitest';

import { routeUsesIntegratedAccountNavigation } from './AuthUserMenu';

describe('account navigation placement', () => {
  it('uses the integrated account entry on shared-shell and workspace routes', () => {
    expect(routeUsesIntegratedAccountNavigation('/')).toBe(true);
    expect(routeUsesIntegratedAccountNavigation('/account/usage')).toBe(true);
    expect(routeUsesIntegratedAccountNavigation('/research-reports')).toBe(true);
    expect(routeUsesIntegratedAccountNavigation('/eval-platform/runs/run-1')).toBe(true);
    expect(routeUsesIntegratedAccountNavigation('/project-1/chat')).toBe(true);
  });

  it('keeps the floating fallback on pages with a custom header', () => {
    expect(routeUsesIntegratedAccountNavigation('/skills')).toBe(false);
    expect(routeUsesIntegratedAccountNavigation('/eval-platform')).toBe(false);
  });
});
