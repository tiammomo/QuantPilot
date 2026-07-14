export const TOOL_OUTPUT_PREVIEW_LIMIT = 12_000;

const markerFor = (omittedChars: number, originalChars: number) =>
  `\n\n[QuantPilot 已截断 ${omittedChars} 个字符；原始输出 ${originalChars} 个字符，以下保留末尾诊断信息。]\n\n`;

/**
 * Keep persisted/client tool output bounded while retaining both the command
 * prelude and the diagnostic tail (where build errors and stack traces live).
 */
export function compactToolOutputPreview(
  value: string,
  limit = TOOL_OUTPUT_PREVIEW_LIMIT,
): string {
  if (value.length <= limit) {
    return value;
  }

  if (limit <= 0) {
    return '';
  }

  let marker = markerFor(value.length, value.length);
  let preservedChars = Math.max(0, limit - marker.length);

  // The omitted count changes the marker width. Two passes are enough for the
  // decimal width to settle, but keep this bounded and defensive.
  for (let index = 0; index < 4; index += 1) {
    const omittedChars = value.length - preservedChars;
    const nextMarker = markerFor(omittedChars, value.length);
    const nextPreservedChars = Math.max(0, limit - nextMarker.length);
    marker = nextMarker;
    if (nextPreservedChars === preservedChars) break;
    preservedChars = nextPreservedChars;
  }

  if (marker.length >= limit) {
    return marker.slice(0, limit);
  }

  const tailChars = Math.min(Math.floor(preservedChars / 3), 4_000);
  const headChars = preservedChars - tailChars;
  return `${value.slice(0, headChars)}${marker}${tailChars > 0 ? value.slice(-tailChars) : ''}`;
}
