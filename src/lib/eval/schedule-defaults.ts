import type { QuantEvalScheduleConfig } from './types';

export function defaultScheduleConfig(): QuantEvalScheduleConfig {
  return {
    enabled: false,
    intervalHours: 24,
    cli: 'claude',
    model: 'deepseek-v4-flash',
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
