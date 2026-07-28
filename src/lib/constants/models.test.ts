import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_MODEL_ID,
  LOCAL_QWEN_MODEL_ID,
  MODELPORT_DEEPSEEK_MODEL_ID,
  PI_AGENT_MODEL_DEFINITIONS,
  getPiAgentModelDefinition,
  normalizePiAgentModelId,
} from './models';

describe('PI Agent model registry', () => {
  it('uses local Qwen by default while preserving DeepSeek as an option', () => {
    expect(normalizePiAgentModelId()).toBe(LOCAL_QWEN_MODEL_ID);
    expect(normalizePiAgentModelId(LOCAL_QWEN_MODEL_ID)).toBe(LOCAL_QWEN_MODEL_ID);
    expect(normalizePiAgentModelId('qwen3.5-9b-q5km')).toBe(LOCAL_QWEN_MODEL_ID);
    expect(PI_AGENT_MODEL_DEFINITIONS.map((model) => model.id)).toEqual([
      LOCAL_QWEN_MODEL_ID,
      MODELPORT_DEEPSEEK_MODEL_ID,
      DEEPSEEK_MODEL_ID,
    ]);
    expect(normalizePiAgentModelId('deepseek')).toBe(MODELPORT_DEEPSEEK_MODEL_ID);
    expect(normalizePiAgentModelId('deepseek-v4-flash')).toBe(DEEPSEEK_MODEL_ID);
  });

  it('falls back safely for unregistered client-supplied model IDs', () => {
    expect(normalizePiAgentModelId('http://untrusted.example/model')).toBe(LOCAL_QWEN_MODEL_ID);
    expect(getPiAgentModelDefinition('unknown').provider).toBe('openai');
  });
});
