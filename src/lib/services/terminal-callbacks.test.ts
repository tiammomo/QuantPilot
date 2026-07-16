import { describe, expect, it, vi } from 'vitest';

import { runIndependentTerminalCallbacks } from './terminal-callbacks';

describe('runIndependentTerminalCallbacks', () => {
  it('still invokes the caller callback when quota recording fails', async () => {
    const quotaFailure = new Error('quota unavailable');
    const callerCallback = vi.fn(async () => undefined);

    await expect(runIndependentTerminalCallbacks([
      async () => { throw quotaFailure; },
      callerCallback,
    ])).rejects.toBe(quotaFailure);

    expect(callerCallback).toHaveBeenCalledOnce();
  });

  it('reports every failure after all callbacks have run', async () => {
    const first = new Error('first');
    const second = new Error('second');
    const lastCallback = vi.fn(async () => undefined);

    const error = await runIndependentTerminalCallbacks([
      async () => { throw first; },
      async () => { throw second; },
      lastCallback,
    ]).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([first, second]);
    expect(lastCallback).toHaveBeenCalledOnce();
  });
});
