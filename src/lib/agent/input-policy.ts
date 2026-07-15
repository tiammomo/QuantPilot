const MAX_INSTRUCTION_BYTES = 256 * 1024;
const MAX_REQUEST_ID_CHARS = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export interface MoAgentIngressInput {
  instruction: string;
  displayInstruction?: string | null;
  requestId: string;
}

export type MoAgentIngressDecision =
  | { ok: true }
  | { ok: false; status: 400 | 413; error: string };

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Fail-closed product ingress policy. This runs before project lookup or any
 * message persistence; the Provider performs a second limit after the complete
 * model request has been assembled.
 */
export function validateMoAgentIngressInput(
  input: MoAgentIngressInput
): MoAgentIngressDecision {
  if (
    utf8ByteLength(input.instruction) > MAX_INSTRUCTION_BYTES ||
    (input.displayInstruction !== null &&
      input.displayInstruction !== undefined &&
      utf8ByteLength(input.displayInstruction) > MAX_INSTRUCTION_BYTES)
  ) {
    return { ok: false, status: 413, error: 'Instruction is too large' };
  }
  if (
    input.requestId.length > MAX_REQUEST_ID_CHARS ||
    !REQUEST_ID_PATTERN.test(input.requestId)
  ) {
    return { ok: false, status: 400, error: 'Invalid requestId' };
  }
  return { ok: true };
}

export const MOAGENT_INGRESS_LIMITS = Object.freeze({
  maxInstructionBytes: MAX_INSTRUCTION_BYTES,
  maxRequestIdChars: MAX_REQUEST_ID_CHARS,
});
