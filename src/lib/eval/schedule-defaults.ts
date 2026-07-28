import type { QuantEvalScheduleConfig } from './types';
import { PI_AGENT_DEFAULT_MODEL } from '@/lib/constants/models';

export function defaultScheduleConfig(): QuantEvalScheduleConfig {
  return {
    enabled: false,
    intervalHours: 24,
    cli: 'pi',
    model: PI_AGENT_DEFAULT_MODEL,
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
