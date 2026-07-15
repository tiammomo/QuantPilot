export interface ParsedMoAgentToolArguments {
  value: unknown;
  normalized: string;
  repaired: boolean;
}
function unwrapJsonFence(value: string): string {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? value;
}

/**
 * Models occasionally place literal newlines or tabs inside a JSON string.
 * Escape only control characters while inside a quoted string; structural
 * whitespace stays untouched.
 */
function escapeStringControlCharacters(value: string): string {
  let output = '';
  let inString = false;
  let escaped = false;

  for (const character of value) {
    if (!inString) {
      output += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      output += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      output += character;
      inString = false;
      continue;
    }
    if (character === '\n') output += '\\n';
    else if (character === '\r') output += '\\r';
    else if (character === '\t') output += '\\t';
    else if (character.charCodeAt(0) < 0x20) {
      output += `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
    } else output += character;
  }

  return output;
}

function removeTrailingCommas(value: string): string {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === ',') {
      let cursor = index + 1;
      while (cursor < value.length && /\s/.test(value[cursor])) cursor += 1;
      if (value[cursor] === '}' || value[cursor] === ']') continue;
    }
    output += character;
  }

  return output;
}

function boundedObjectSlice(value: string): string | null {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return value.slice(start, end + 1).trim();
}

/**
 * Parse provider-produced tool arguments with a deliberately small repair
 * surface. Repairs never invent fields: they only unwrap a JSON fence, escape
 * illegal control characters inside strings, remove trailing commas, or drop
 * prose surrounding one complete JSON object.
 */
export function parseMoAgentToolArguments(raw: string): ParsedMoAgentToolArguments {
  const initial = raw.trim() || '{}';
  const candidates: string[] = [initial];
  const unfenced = unwrapJsonFence(initial);
  candidates.push(unfenced);
  const objectSlice = boundedObjectSlice(unfenced);
  if (objectSlice) candidates.push(objectSlice);

  for (const candidate of Array.from(new Set(candidates))) {
    const repaired = removeTrailingCommas(escapeStringControlCharacters(candidate));
    for (const attempt of Array.from(new Set([candidate, repaired]))) {
      try {
        const value = JSON.parse(attempt) as unknown;
        return {
          value,
          normalized: JSON.stringify(value),
          repaired: attempt !== initial,
        };
      } catch {
        // Try the next bounded, semantics-preserving candidate.
      }
    }
  }

  // Preserve the native JSON diagnostic for the model-facing tool result.
  JSON.parse(initial);
  throw new SyntaxError('Tool arguments must be valid JSON.');
}
