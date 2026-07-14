import { describe, expect, it } from 'vitest';
import {
  EXPLICIT_PREVIEW_STOP_INTENT,
  isExplicitPreviewStopIntent,
} from './preview-stop-intent';

describe('explicit preview stop intent', () => {
  it('ignores legacy empty unload beacons', () => {
    expect(isExplicitPreviewStopIntent({})).toBe(false);
  });

  it('accepts the current explicit stop action', () => {
    expect(
      isExplicitPreviewStopIntent({
        bodyIntent: EXPLICIT_PREVIEW_STOP_INTENT,
      }),
    ).toBe(true);
  });
});
