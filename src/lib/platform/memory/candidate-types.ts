export const PERSONAL_MEMORY_PREFERENCE_KEYS = [
  'output.answer_style',
  'output.detail_level',
  'output.visual_style',
  'analysis.risk_style',
  'analysis.default_market',
  'research.default_horizon',
  'research.evidence_style',
] as const;

export type PersonalMemoryPreferenceKey =
  (typeof PERSONAL_MEMORY_PREFERENCE_KEYS)[number];
export type PersonalMemoryScope = 'global' | 'project';
