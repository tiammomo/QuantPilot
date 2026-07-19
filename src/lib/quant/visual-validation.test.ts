import { describe, expect, it } from 'vitest';
import {
  assessFinancialWorkbenchSurface,
  assessMetricStripBalance,
  isVisualValidationInfrastructureError,
} from './visual-validation';

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

describe('financial workbench surface composition', () => {
  it('rejects a first viewport dominated by a rounded card grid', () => {
    const result = assessFinancialWorkbenchSurface({
      contentRegionCount: 9,
      cardLikeSurfaceCount: 7,
      firstViewportCardLikeSurfaceCount: 6,
      cardGridClusterCount: 1,
      cardLikeSurfaceRatio: 7 / 9,
      firstViewportCardLikeSurfaceRatio: 0.75,
    });

    expect(result.failures).toEqual([
      expect.stringContaining('独立圆角卡片网格'),
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('accepts a continuous canvas with a small number of detached alerts', () => {
    expect(assessFinancialWorkbenchSurface({
      contentRegionCount: 16,
      cardLikeSurfaceCount: 2,
      firstViewportCardLikeSurfaceCount: 1,
      cardGridClusterCount: 0,
      cardLikeSurfaceRatio: 0.125,
      firstViewportCardLikeSurfaceRatio: 0.1,
    })).toEqual({ failures: [], warnings: [] });
  });

  it('rejects a card-dominant page even when cards are not sibling grid items', () => {
    const result = assessFinancialWorkbenchSurface({
      contentRegionCount: 13,
      cardLikeSurfaceCount: 8,
      firstViewportCardLikeSurfaceCount: 4,
      cardGridClusterCount: 0,
      cardLikeSurfaceRatio: 8 / 13,
      firstViewportCardLikeSurfaceRatio: 4 / 6,
    });

    expect(result.failures).toEqual([
      expect.stringContaining('独立圆角卡片网格'),
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('warns before a page crosses the blocking card-grid threshold', () => {
    const result = assessFinancialWorkbenchSurface({
      contentRegionCount: 14,
      cardLikeSurfaceCount: 8,
      firstViewportCardLikeSurfaceCount: 4,
      cardGridClusterCount: 0,
      cardLikeSurfaceRatio: 8 / 14,
      firstViewportCardLikeSurfaceRatio: 0.4,
    });

    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining('独立卡片式容器偏多'),
    ]);
  });
});

describe('metric strip balance', () => {
  it('rejects an orphaned narrow metric on a desktop row', () => {
    expect(assessMetricStripBalance({
      viewportId: 'desktop',
      orphanedMetricRowCount: 1,
    })).toEqual([
      expect.stringContaining('末行只有一个窄指标'),
    ]);
  });

  it('does not apply the desktop density rule to a mobile stack', () => {
    expect(assessMetricStripBalance({
      viewportId: 'mobile',
      orphanedMetricRowCount: 1,
    })).toEqual([]);
  });
});
