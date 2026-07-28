import { describe, expect, it } from 'vitest';

import { parsePiAgentToolArguments } from './tool-arguments';

describe('parsePiAgentToolArguments', () => {
  it('keeps valid JSON canonical and unchanged in meaning', () => {
    expect(parsePiAgentToolArguments('{"path":"app/page.tsx","anchors":["main"]}'))
      .toEqual({
        value: { path: 'app/page.tsx', anchors: ['main'] },
        normalized: '{"path":"app/page.tsx","anchors":["main"]}',
        repaired: false,
      });
  });

  it('repairs fenced JSON, trailing commas, and raw newlines inside strings', () => {
    const parsed = parsePiAgentToolArguments(`\`\`\`json
{"path":"app/page.tsx","anchors":["function Header() {
  return null
}",],}
\`\`\``);

    expect(parsed.repaired).toBe(true);
    expect(parsed.value).toEqual({
      path: 'app/page.tsx',
      anchors: ['function Header() {\n  return null\n}'],
    });
    expect(() => JSON.parse(parsed.normalized)).not.toThrow();
  });

  it('does not invent structure for incomplete JSON', () => {
    expect(() => parsePiAgentToolArguments('{"path":"app/page.tsx"'))
      .toThrow();
  });
});
