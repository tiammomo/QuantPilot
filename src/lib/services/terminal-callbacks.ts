import type { Awaitable } from '@/lib/agent/types';

/**
 * Run terminal observers without allowing one failed observer to suppress the
 * rest. The caller receives the original failure (or an AggregateError), while
 * the durable session decides how terminal-notification failures are reported.
 */
export async function runIndependentTerminalCallbacks(
  callbacks: readonly (() => Awaitable<void>)[]
): Promise<void> {
  const failures: unknown[] = [];
  for (const callback of callbacks) {
    try {
      await callback();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Multiple terminal run callbacks failed.');
  }
}
