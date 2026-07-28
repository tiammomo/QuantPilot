export const PRODUCT_CLI_ID = 'pi' as const;
export const PRODUCT_AGENT_FRAMEWORK = 'PI Agent' as const;

export type ProductCliId = typeof PRODUCT_CLI_ID;

export function normalizeProductCliId(value: unknown): ProductCliId | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === PRODUCT_CLI_ID ? PRODUCT_CLI_ID : undefined;
}

export function normalizeProductCliIdOrDefault(value: unknown): ProductCliId {
  return normalizeProductCliId(value) ?? PRODUCT_CLI_ID;
}
