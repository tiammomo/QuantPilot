import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '@/types';
import { collapseToolReadActivities } from './tool-activity';

function activity(id: string, success: boolean, anchors: string[]): ChatMessage {
  return {
    id,
    projectId: 'project-1',
    requestId: 'request-1',
    role: 'assistant',
    messageType: 'tool_use',
    content: 'Using tool: query_text_file on app/page.tsx',
    createdAt: `2026-07-15T00:00:0${id}.000Z`,
    metadata: {
      toolName: 'query_text_file',
      target: 'app/page.tsx',
      success,
      toolInput: { path: 'app/page.tsx', anchors },
      summary: success ? '读取完成' : '参数需要调整',
    },
  };
}

describe('collapseToolReadActivities', () => {
  it('collapses repeated reads and absorbs recovered failures', () => {
    const result = collapseToolReadActivities([
      activity('1', false, ['bad']),
      activity('2', true, ['Header']),
      activity('3', true, ['Chart']),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
    expect(result[0].metadata).toMatchObject({
      success: true,
      activityAttemptCount: 3,
      activityFailureCount: 1,
      recoveredFailureCount: 1,
      summary: '已汇总 app/page.tsx 的 3 组源码定位结果。',
    });
  });

  it('does not collapse reads across requests', () => {
    const second = { ...activity('2', true, ['Chart']), requestId: 'request-2' };
    expect(collapseToolReadActivities([activity('1', true, ['Header']), second]))
      .toHaveLength(2);
  });
});
