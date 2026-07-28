import { describe, expect, it } from 'vitest';

import {
  ACTIVE_CLI_IDS,
  DEFAULT_ACTIVE_CLI,
  sanitizeActiveCli,
} from './cliOptions';

describe('product CLI normalization', () => {
  it('uses PI as the only active and default CLI', () => {
    expect(ACTIVE_CLI_IDS).toEqual(['pi']);
    expect(DEFAULT_ACTIVE_CLI).toBe('pi');
  });

  it('keeps PI canonical and falls back to PI for unknown values', () => {
    expect(sanitizeActiveCli('PI')).toBe('pi');
    expect(sanitizeActiveCli('unknown')).toBe('pi');
  });
});
