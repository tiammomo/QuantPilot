import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_MODEL_ID,
  LOCAL_QWEN_MODEL_ID,
  MODELPORT_DEEPSEEK_MODEL_ID,
  MOAGENT_MODEL_DEFINITIONS,
  getMoAgentModelDefinition,
  normalizeMoAgentModelId,
} from './models';

describe('MoAgent model registry', () => {
  it('uses local Qwen by default while preserving DeepSeek as an option', () => {
    expect(normalizeMoAgentModelId()).toBe(LOCAL_QWEN_MODEL_ID);
    expect(normalizeMoAgentModelId(LOCAL_QWEN_MODEL_ID)).toBe(LOCAL_QWEN_MODEL_ID);
    expect(normalizeMoAgentModelId('qwen3.5-9b-q5km')).toBe(LOCAL_QWEN_MODEL_ID);
    expect(MOAGENT_MODEL_DEFINITIONS.map((model) => model.id)).toEqual([
      LOCAL_QWEN_MODEL_ID,
      MODELPORT_DEEPSEEK_MODEL_ID,
      DEEPSEEK_MODEL_ID,
    ]);
    expect(normalizeMoAgentModelId('deepseek')).toBe(MODELPORT_DEEPSEEK_MODEL_ID);
    expect(normalizeMoAgentModelId('deepseek-v4-flash')).toBe(DEEPSEEK_MODEL_ID);
  });

  it('falls back safely for unregistered client-supplied model IDs', () => {
    expect(normalizeMoAgentModelId('http://untrusted.example/model')).toBe(LOCAL_QWEN_MODEL_ID);
    expect(getMoAgentModelDefinition('unknown').provider).toBe('openai');
  });
});
