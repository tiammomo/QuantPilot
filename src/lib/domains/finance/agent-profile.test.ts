import { describe, expect, it } from 'vitest';

import {
  createQuantPilotDataAgentRegistry,
  getFinanceSkillCapabilityDescriptor,
  QUANTPILOT_AGENT_PROFILE,
} from './agent-profile';

describe('Quant finance Data Agent profile', () => {
  it('registers as a domain pack without teaching Data Agent core about finance', () => {
    const resolved = createQuantPilotDataAgentRegistry()
      .resolveProfile(QUANTPILOT_AGENT_PROFILE.id);

    expect(resolved.defaultCapability.id).toBe('stock_diagnosis');
    expect(resolved.domainPacks[0].resolverIds).toContain('finance.security-resolver');
    expect(resolved.deliveryPack.id).toBe('workspace.next-dashboard');
  });

  it('projects Quant capability details into the product-neutral Skill contract', () => {
    expect(getFinanceSkillCapabilityDescriptor('technical_analysis')).toMatchObject({
      id: 'technical_analysis',
      status: 'ready',
      requiredSkillIds: expect.arrayContaining(['quant-market-data', 'quant-indicators']),
    });
  });
});
