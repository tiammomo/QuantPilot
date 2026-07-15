import { describe, expect, it } from 'vitest';
import {
  MOAGENT_INGRESS_LIMITS,
  validateMoAgentIngressInput,
} from './input-policy';

describe('validateMoAgentIngressInput', () => {
  it('accepts values at the documented boundaries', () => {
    expect(validateMoAgentIngressInput({
      instruction: 'a'.repeat(MOAGENT_INGRESS_LIMITS.maxInstructionBytes),
      displayInstruction: '可见指令',
      requestId: `r${'a'.repeat(MOAGENT_INGRESS_LIMITS.maxRequestIdChars - 1)}`,
    })).toEqual({ ok: true });
  });

  it('counts instruction and display instruction limits in UTF-8 bytes', () => {
    const oversizedUnicode = '量'.repeat(
      Math.floor(MOAGENT_INGRESS_LIMITS.maxInstructionBytes / 3) + 1
    );
    expect(validateMoAgentIngressInput({
      instruction: oversizedUnicode,
      requestId: 'request-1',
    })).toEqual({ ok: false, status: 413, error: 'Instruction is too large' });
    expect(validateMoAgentIngressInput({
      instruction: 'ok',
      displayInstruction: oversizedUnicode,
      requestId: 'request-1',
    })).toEqual({ ok: false, status: 413, error: 'Instruction is too large' });
  });

  it.each([
    '',
    '-leading-separator',
    'contains space',
    'contains/slash',
    `r${'a'.repeat(MOAGENT_INGRESS_LIMITS.maxRequestIdChars)}`,
  ])('rejects invalid requestId %j', (requestId) => {
    expect(validateMoAgentIngressInput({
      instruction: 'ok',
      requestId,
    })).toEqual({ ok: false, status: 400, error: 'Invalid requestId' });
  });
});
