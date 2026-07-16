import { describe, expect, it } from 'vitest';
import {
  CHAT_PANE_DEFAULT_WIDTH,
  CHAT_PANE_MIN_WIDTH,
  clampChatPaneWidth,
  parseStoredChatPaneWidth,
} from './pane-layout';

describe('chat workspace pane layout', () => {
  it('keeps the chat pane inside its desktop bounds', () => {
    expect(clampChatPaneWidth(200, 1_440)).toBe(CHAT_PANE_MIN_WIDTH);
    expect(clampChatPaneWidth(700, 1_440)).toBe(700);
    expect(clampChatPaneWidth(1_200, 1_440)).toBe(960);
  });

  it('preserves enough room for the preview on narrower desktop viewports', () => {
    expect(clampChatPaneWidth(900, 1_024)).toBe(604);
  });

  it('accepts only finite persisted widths', () => {
    expect(parseStoredChatPaneWidth('640', 1_440)).toBe(640);
    expect(parseStoredChatPaneWidth('not-a-number', 1_440)).toBeNull();
    expect(parseStoredChatPaneWidth(null, 1_440)).toBeNull();
    expect(clampChatPaneWidth(Number.NaN, 1_440)).toBe(CHAT_PANE_DEFAULT_WIDTH);
  });
});
