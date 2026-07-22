import { describe, expect, it } from 'vitest';

import { DataAgentRegistry } from '@/lib/data-agent';
import {
  FINANCE_DOMAIN_PACK,
  getFinanceSkillCapabilityDescriptor,
  QUANTPILOT_AGENT_PROFILE,
} from './agent-profile';

describe('Quant finance Data Agent profile', () => {
  it('registers as a domain pack without teaching Data Agent core about finance', () => {
    const resolved = new DataAgentRegistry()
      .registerDomainPack(FINANCE_DOMAIN_PACK)
      .registerProfile(QUANTPILOT_AGENT_PROFILE)
      .resolveProfile(QUANTPILOT_AGENT_PROFILE.id);

    expect(resolved.defaultCapability.id).toBe('stock_diagnosis');
    expect(resolved.domainPacks[0].resolverIds).toContain('finance.security-resolver');
  });

  it('projects Quant capability details into the product-neutral Skill contract', () => {
    expect(getFinanceSkillCapabilityDescriptor('technical_analysis')).toMatchObject({
      id: 'technical_analysis',
      status: 'ready',
      requiredSkillIds: expect.arrayContaining(['quant-market-data', 'quant-indicators']),
    });
  });
});
