import { describe, expect, it } from 'vitest';

import {
  ChatActContractError,
  MAX_CHAT_ACT_IMAGE_ATTACHMENTS,
  parseChatActRequest,
} from './chat-act-contract';

describe('chat act request contract', () => {
  it('accepts the single current camelCase contract', () => {
    expect(parseChatActRequest({
      instruction: '分析宁德时代',
      displayInstruction: '分析宁德时代',
      requestId: 'request-1',
      selectedModel: 'local_qwen:qwen3.5-9b-q5km',
      images: [{ name: 'holding.png', path: 'assets/holding.png', mimeType: 'image/png' }],
      isInitialPrompt: true,
      quantCapabilityId: 'single-stock-diagnosis',
      quantCapabilitySource: 'manual',
    })).toMatchObject({
      requestId: 'request-1',
      images: [{ path: 'assets/holding.png' }],
      isInitialPrompt: true,
    });
  });

  it('supports an image-only request after the upload step', () => {
    const parsed = parseChatActRequest({ images: [{ path: 'assets/portfolio.png' }] });
    expect(parsed.instruction).toBe('');
    expect(parsed.images).toHaveLength(1);
  });

  it.each([
    { instruction: 'x', request_id: 'old' },
    { instruction: 'x', selected_model: 'old' },
    { instruction: 'x', cliPreference: 'moagent' },
    { instruction: 'x', images: [{ path: '/tmp/portfolio.png' }] },
    { instruction: 'x', images: [{ path: 'assets/../portfolio.png' }] },
    { instruction: 'x', images: [{ path: 'assets/portfolio.png', base64_data: 'abc' }] },
  ])('rejects obsolete or unsafe input %#', (input) => {
    expect(() => parseChatActRequest(input)).toThrow(ChatActContractError);
  });

  it('bounds attachment fan-out', () => {
    expect(() => parseChatActRequest({
      images: Array.from(
        { length: MAX_CHAT_ACT_IMAGE_ATTACHMENTS + 1 },
        (_, index) => ({ path: `assets/${index}.png` }),
      ),
    })).toThrow(ChatActContractError);
  });
});
