import type { QuantEvalScheduleConfig } from './types';
import { MOAGENT_DEFAULT_MODEL } from '@/lib/constants/models';

export function defaultScheduleConfig(): QuantEvalScheduleConfig {
  return {
    enabled: false,
    intervalHours: 24,
    cli: 'moagent',
    model: MOAGENT_DEFAULT_MODEL,
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
