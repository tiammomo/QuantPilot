import { DataAgentGenerationRuntimeRegistry } from "@/lib/data-agent";
import { FINANCE_GENERATION_HANDLER } from "@/lib/quant/finance-generation-executor";
import { executeFinanceResearchPreparation } from './finance-research-preparation';

export function createApplicationGenerationRuntime(): DataAgentGenerationRuntimeRegistry {
  return new DataAgentGenerationRuntimeRegistry().register(
    {
      profileId: FINANCE_GENERATION_HANDLER.profileId,
      async execute(job) {
        const envelope = job.executionEnvelope as { payload?: { phase?: unknown } };
        if (envelope.payload?.phase === 'preparation') return executeFinanceResearchPreparation(job);
        return FINANCE_GENERATION_HANDLER.execute(job);
      },
    },
  );
}
