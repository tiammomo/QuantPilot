import { describe, expect, it } from 'vitest';
import { isRuntimeOnlyChatProjection } from './message';

describe('MoAgent conversation history projection filter', () => {
  it('drops intermediate and hidden platform/model narration', () => {
    expect(isRuntimeOnlyChatProjection({
      role: 'assistant',
      metadataJson: JSON.stringify({ isWorkspaceProgress: true, progressStep: 2 }),
    })).toBe(true);
    expect(isRuntimeOnlyChatProjection({
      role: 'assistant',
      metadataJson: JSON.stringify({ isMoAgentIntermediateTurn: true }),
    })).toBe(true);
    expect(isRuntimeOnlyChatProjection({
      role: 'assistant',
      metadataJson: JSON.stringify({ hidden_from_ui: true }),
    })).toBe(true);
  });

  it('keeps the accepted final workspace projection and all user messages', () => {
    expect(isRuntimeOnlyChatProjection({
      role: 'assistant',
      metadataJson: JSON.stringify({
        isWorkspaceProgress: true,
        isMoAgentFinal: true,
        progressStep: 5,
      }),
    })).toBe(false);
    expect(isRuntimeOnlyChatProjection({
      role: 'user',
      metadataJson: JSON.stringify({ isMissionIntermediate: true }),
    })).toBe(false);
  });

  it('fails open for malformed legacy metadata', () => {
    expect(isRuntimeOnlyChatProjection({
      role: 'assistant',
      metadataJson: '{invalid',
    })).toBe(false);
  });
});
