export const CHAT_PANE_DEFAULT_WIDTH = 416;
export const CHAT_PANE_MIN_WIDTH = 320;
export const CHAT_PANE_MAX_WIDTH = 960;
export const PREVIEW_PANE_MIN_WIDTH = 420;
export const CHAT_PANE_WIDTH_STORAGE_KEY = 'quantpilot:chat-pane-width';

export function clampChatPaneWidth(width: number, viewportWidth: number): number {
  const safeViewportWidth = Number.isFinite(viewportWidth) && viewportWidth > 0
    ? viewportWidth
    : CHAT_PANE_DEFAULT_WIDTH + PREVIEW_PANE_MIN_WIDTH;
  const availableWidth = Math.floor(safeViewportWidth) - PREVIEW_PANE_MIN_WIDTH;
  const effectiveMaxWidth = Math.max(
    CHAT_PANE_MIN_WIDTH,
    Math.min(CHAT_PANE_MAX_WIDTH, availableWidth),
  );
  const safeWidth = Number.isFinite(width) ? width : CHAT_PANE_DEFAULT_WIDTH;

  return Math.round(
    Math.min(effectiveMaxWidth, Math.max(CHAT_PANE_MIN_WIDTH, safeWidth)),
  );
}

export function parseStoredChatPaneWidth(
  value: string | null,
  viewportWidth: number,
): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? clampChatPaneWidth(parsed, viewportWidth)
    : null;
}
