import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    platformSetting: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

import { PI_AGENT_DEFAULT_MODEL } from '@/lib/constants/models';
import { normalizeCliSettings } from './settings';

describe('global settings CLI normalization', () => {
  it('emits only canonical PI settings', () => {
    expect(normalizeCliSettings({
      pi: { model: PI_AGENT_DEFAULT_MODEL },
    })).toEqual({
      pi: { model: PI_AGENT_DEFAULT_MODEL },
    });
  });

  it('ignores non-object settings', () => {
    expect(normalizeCliSettings(null)).toBeUndefined();
    expect(normalizeCliSettings('pi')).toBeUndefined();
  });
});
