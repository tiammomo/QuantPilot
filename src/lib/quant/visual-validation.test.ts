import { describe, expect, it } from 'vitest';
import { isVisualValidationInfrastructureError } from './visual-validation';

describe('visual validation infrastructure errors', () => {
  it.each([
    "browserType.launch: Executable doesn't exist at /tmp/chromium-headless-shell",
    'Looks like Playwright was just installed. Run npx playwright install',
    "Cannot find package 'playwright' imported from visual-validation.ts",
  ])('recognizes a missing Playwright runtime in %s', (message) => {
    expect(isVisualValidationInfrastructureError(new Error(message))).toBe(true);
  });

  it('does not downgrade real page failures to infrastructure warnings', () => {
    expect(isVisualValidationInfrastructureError(new Error('page.goto: net::ERR_CONNECTION_REFUSED'))).toBe(
      false
    );
  });
});
