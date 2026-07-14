export const EXPLICIT_PREVIEW_STOP_INTENT = 'explicit-user-stop';

export function isExplicitPreviewStopIntent(params: {
  headerIntent?: string | null;
  bodyIntent?: unknown;
}): boolean {
  return (
    params.headerIntent === EXPLICIT_PREVIEW_STOP_INTENT ||
    params.bodyIntent === EXPLICIT_PREVIEW_STOP_INTENT
  );
}
