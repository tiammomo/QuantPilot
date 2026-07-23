import { DataAgentGenerationRuntimeRegistry } from "@/lib/data-agent";
import { FINANCE_GENERATION_HANDLER } from "@/lib/quant/finance-generation-executor";

export function createApplicationGenerationRuntime(): DataAgentGenerationRuntimeRegistry {
  return new DataAgentGenerationRuntimeRegistry().register(
    FINANCE_GENERATION_HANDLER,
  );
}
