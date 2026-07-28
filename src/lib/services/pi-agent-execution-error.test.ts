import { describe, expect, it } from 'vitest';

import {
  classifyPiAgentExecutionError,
  PiAgentExecutionError,
} from './pi-agent-execution-error';

describe('PI Agent execution failure classification', () => {
  it('preserves an explicitly structured execution failure', () => {
    const error = new PiAgentExecutionError(
      'CONTEXT_BUDGET_EXCEEDED',
      'context is too large',
      { repairableByValidation: false },
    );

    expect(classifyPiAgentExecutionError(error)).toBe(error);
  });

  it('recognizes a Prisma missing-table failure through wrapper causes', () => {
    const prismaError = Object.assign(new Error('The table public.agent_runs does not exist.'), {
      code: 'P2021',
    });
    const wrapped = new Error('PI Agent startup failed', { cause: prismaError });

    expect(classifyPiAgentExecutionError(wrapped)).toMatchObject({
      code: 'PI_AGENT_SCHEMA_NOT_READY',
      repairableByValidation: false,
    });
  });

  it('normalizes the explicit schema-readiness gate error for the product layer', () => {
    const cause = Object.assign(new Error('deployment catalog mismatch'), {
      code: 'PI_AGENT_SCHEMA_NOT_READY',
    });

    expect(classifyPiAgentExecutionError(cause)).toMatchObject({
      code: 'PI_AGENT_SCHEMA_NOT_READY',
      message: 'PI Agent 数据库结构未就绪，请先执行数据库迁移后再重试。',
      repairableByValidation: false,
    });
  });

  it('allows only bounded model-completion failures into validation repair', () => {
    expect(classifyPiAgentExecutionError({
      code: 'MAX_TURNS',
      message: 'turn limit',
    })).toMatchObject({ repairableByValidation: true });
    expect(classifyPiAgentExecutionError({
      code: 'PROVIDER_AUTHENTICATION_FAILED',
      message: 'bad credentials',
    })).toMatchObject({ repairableByValidation: false });
  });

  it('does not guess for an unstructured product error', () => {
    expect(classifyPiAgentExecutionError(new Error('unknown product failure'))).toBeNull();
  });
});
