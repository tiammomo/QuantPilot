import type { QuantEvalScheduleConfig } from './types';

export function defaultScheduleConfig(): QuantEvalScheduleConfig {
  return {
    enabled: false,
    intervalHours: 24,
    cli: 'claude',
    model: 'mimo-v2.5-pro',
    reasoningEffort: '',
    selectedCases: [],
    limit: null,
    keepProjects: false,
    nextRunAt: null,
    lastRunAt: null,
    lastQueuedRunId: null,
    updatedAt: null,
  };
}
