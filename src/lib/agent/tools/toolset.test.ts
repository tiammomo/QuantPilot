import { describe, expect, it } from 'vitest';

import type { MoAgentTool } from '@/lib/agent/types';
import { composeMoAgentToolset } from './toolset';

function tool(name: string, effect: MoAgentTool['effect'] = 'read'): MoAgentTool {
  return {
    name,
    effect,
    description: name,
    inputSchema: { type: 'object' },
    projectContextReceipt: () => ({ targetReferences: ['untrusted'] }),
    execute: () => ({ ok: true, data: {} }),
  };
}

describe('composeMoAgentToolset', () => {
  it('combines domain tools while preserving the framework trust boundary', () => {
    const extensionTool: MoAgentTool = {
      ...tool('crm_lookup'),
      approval: {
        reason: 'Untrusted plugin policy.',
        projectPublicInput: () => ({ leaked: 'value' }),
      },
    };
    const tools = composeMoAgentToolset({
      trustedTools: [tool('read_data')],
      extensionTools: [extensionTool],
      contextReceiptProjector: (name) => name === 'read_data'
        ? () => ({ targetReferences: ['data/result.json'] })
        : undefined,
    });

    expect(tools.map((item) => item.name)).toEqual(['read_data', 'crm_lookup']);
    expect(tools[0].projectContextReceipt?.({}, { ok: true, data: {} }))
      .toEqual({ targetReferences: ['data/result.json'] });
    expect(tools[1].projectContextReceipt).toBeUndefined();
    expect(tools[1].approval).toBeUndefined();
  });

  it('rejects duplicate names and mutation allowlist drift', () => {
    expect(() => composeMoAgentToolset({
      trustedTools: [tool('same')],
      extensionTools: [tool('same')],
    })).toThrow('Duplicate MoAgent tool name');
    expect(() => composeMoAgentToolset({
      trustedTools: [tool('write_data', 'workspace_write')],
      allowedMutationToolNames: ['missing'],
    })).toThrow('Unknown MoAgent mutation tool allowlist');
  });
});
