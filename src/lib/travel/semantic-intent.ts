import { z } from 'zod';

export type TravelRouteMode = 'culture' | 'mixed';
export type TravelWalkPreference = 'low' | 'medium' | 'high';
export type TravelMealType = 'meal' | 'snack' | 'coffee' | 'dessert' | null;
export type TravelPersona = 'senior' | 'family' | 'couple' | 'friends' | null;
export type TravelReplanAction = 'add_stop' | 'replace_stop' | 'remove_stop' | 'preserve_route' | 'tighten_budget' | null;
export type TravelIntentParser = 'cache' | 'dictionary' | 'minimax';

export interface TravelQueryIntent {
  raw_text: string;
  area: string | null;
  duration_minutes: number | null;
  budget_cny: number | null;
  route_mode: TravelRouteMode;
  needs_meal: boolean;
  meal_type: TravelMealType;
  avoid_queue: boolean;
  walk_preference: TravelWalkPreference;
  persona: TravelPersona;
  indoor_preferred: boolean;
  must_include_names: string[];
  exclude_names: string[];
  replan_action: TravelReplanAction;
  parser: TravelIntentParser;
  model: string | null;
  llm_used: boolean;
  llm_attempted: boolean;
  llm_error: string | null;
  llm_elapsed_ms: number;
  cache_hit: boolean;
  cache_layer: 'intent' | null;
  confidence: number;
  missing_fields: string[];
  notes: string[];
}

export interface TravelIntentParseOptions {
  timeoutMs?: number;
}

export class TravelIntentError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'missing_config' | 'timeout' | 'non_json' | 'invalid_json' | 'invalid_schema' | 'model_error',
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TravelIntentError';
  }
}

const INTENT_CACHE_TTL_MS = Number(process.env.TRAVELPILOT_INTENT_CACHE_TTL_MS || 5 * 60 * 1000);
const intentCache = new Map<string, { expiresAt: number; intent: TravelQueryIntent }>();

const AREA_ALIASES: Array<[string, string]> = [
  ['前门', '前门'],
  ['故宫', '故宫'],
  ['天安门', '天安门'],
  ['王府井', '王府井'],
  ['什刹海', '什刹海'],
  ['后海', '什刹海'],
  ['北海', '北海'],
  ['南锣鼓巷', '南锣鼓巷'],
  ['雍和宫', '雍和宫'],
  ['颐和园', '颐和园'],
  ['奥林匹克公园', '奥林匹克公园'],
  ['三里屯', '三里屯'],
  ['798', '798'],
];

const routeModeSchema = z.enum(['culture', 'mixed']).catch('mixed');
const walkPreferenceSchema = z.enum(['low', 'medium', 'high']).catch('medium');
const mealTypeSchema = z.enum(['meal', 'snack', 'coffee', 'dessert']).nullable().catch(null);
const personaSchema = z.enum(['senior', 'family', 'couple', 'friends']).nullable().catch(null);
const replanActionSchema = z.enum(['add_stop', 'replace_stop', 'remove_stop', 'preserve_route', 'tighten_budget']).nullable().catch(null);

const modelIntentSchema = z.object({
  area: z.string().trim().min(1).nullable().catch(null),
  duration_minutes: z.coerce.number().int().min(30).max(1440).nullable().catch(null),
  budget_cny: z.coerce.number().int().min(0).max(100000).nullable().catch(null),
  route_mode: routeModeSchema,
  needs_meal: z.coerce.boolean().catch(false),
  meal_type: mealTypeSchema,
  avoid_queue: z.coerce.boolean().catch(false),
  walk_preference: walkPreferenceSchema,
  persona: personaSchema,
  indoor_preferred: z.coerce.boolean().catch(false),
  must_include_names: z.array(z.string().trim().min(1)).catch([]),
  exclude_names: z.array(z.string().trim().min(1)).catch([]),
  replan_action: replanActionSchema,
  missing_fields: z.array(z.string().trim().min(1)).catch([]),
  confidence: z.coerce.number().min(0).max(1).catch(0.7),
  notes: z.array(z.string().trim().min(1)).catch([]),
});

type ModelIntent = z.infer<typeof modelIntentSchema>;

function normalizeRawText(value: string): string {
  return String(value || '').trim().replace(/^[/／\\]+\s*/, '').replace(/\s+/g, ' ').trim();
}

function cacheKey(rawText: string): string {
  return normalizeRawText(rawText).toLowerCase();
}

function getCachedIntent(key: string): TravelQueryIntent | null {
  const cached = intentCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt < Date.now()) {
    intentCache.delete(key);
    return null;
  }
  return {
    ...cached.intent,
    parser: 'cache',
    cache_hit: true,
    cache_layer: 'intent',
    notes: [...cached.intent.notes, 'Intent cache hit.'],
  };
}

function setCachedIntent(key: string, intent: TravelQueryIntent) {
  intentCache.set(key, {
    expiresAt: Date.now() + INTENT_CACHE_TTL_MS,
    intent: {
      ...intent,
      cache_hit: false,
      cache_layer: null,
    },
  });
}

function parseArea(text: string): string | null {
  return AREA_ALIASES.find(([alias]) => text.includes(alias))?.[1] ?? null;
}

function parseDurationMinutes(text: string): number | null {
  const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:个)?小时/);
  if (hourMatch?.[1]) return Math.round(Number(hourMatch[1]) * 60);
  if (/半日|半天/.test(text)) return 240;
  if (/一天|1天|一日|整天|全天/.test(text)) return 480;
  if (/两天|2天/.test(text)) return 960;
  if (/三天|3天/.test(text)) return 1440;
  return null;
}

function parseBudget(text: string): number | null {
  const budgetMatch = text.match(/(?:预算|人均|不超过|不超|控制在|以内|以下)?\s*(\d{2,5})\s*元?(?:以内|以下|内)?/);
  if (!budgetMatch?.[1]) return null;
  const value = Number(budgetMatch[1]);
  return Number.isFinite(value) ? value : null;
}

function parseNamesAfter(text: string, pattern: RegExp): string[] {
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = String(match[1] || '')
      .replace(/^(这个|那个|这里|那里|地点|地方|景点|餐厅|饭店|第[一二三四五六七八九123456789]个点)/, '')
      .replace(/(吧|呀|啊|呢|了)$/g, '')
      .trim();
    if (!raw) continue;
    for (const name of raw.split(/[、和,，]/).map((item) => item.trim()).filter(Boolean)) {
      if (!/^(吃饭|午餐|午饭|餐饮|景点|地方|点|室内点)$/.test(name)) names.push(name);
    }
  }
  return Array.from(new Set(names));
}

function inferReplanAction(text: string): TravelReplanAction {
  if (/再加|加一个|添加|增加|顺路/.test(text)) return 'add_stop';
  if (/替换|换成|换一个|改成/.test(text)) return 'replace_stop';
  if (/不去|别去|不要去|去掉|排除|删除|取消/.test(text)) return 'remove_stop';
  if (/保留|其他地方不变|原路线|原来的点都保留/.test(text)) return 'preserve_route';
  if (/预算降到|预算控制|预算压到/.test(text)) return 'tighten_budget';
  return null;
}

function missingFieldsFor(intent: Pick<TravelQueryIntent, 'area' | 'duration_minutes'>): string[] {
  const missing: string[] = [];
  if (!intent.area) missing.push('area');
  if (!intent.duration_minutes) missing.push('duration_minutes');
  return missing;
}

function buildClarificationIntent(rawText: string, notes: string[]): TravelQueryIntent {
  const normalized = normalizeRawText(rawText);
  const intent = parseDictionaryIntent(normalized);
  return {
    ...intent,
    notes: [...intent.notes, ...notes],
  };
}

function parseDictionaryIntent(rawText: string): TravelQueryIntent {
  const text = normalizeRawText(rawText);
  const noMeal = /不吃饭|不要吃饭|不安排吃饭/.test(text);
  const needsMeal = !noMeal && /中午|午餐|午饭|吃饭|餐饮|饭店|餐厅|美食|小吃|咖啡|下午茶|甜品/.test(text);
  const routeMode: TravelRouteMode = /文化|博物馆|景点/.test(text) && !needsMeal ? 'culture' : 'mixed';
  const mealType: TravelMealType = noMeal
    ? null
    : /咖啡/.test(text)
      ? 'coffee'
      : /下午茶|甜品|茶饮|奶茶/.test(text)
        ? 'dessert'
        : /小吃/.test(text)
          ? 'snack'
          : needsMeal
            ? 'meal'
            : null;
  const persona: TravelPersona = /老人|长辈|父母/.test(text)
    ? 'senior'
    : /亲子|带娃|孩子|小孩|儿童/.test(text)
      ? 'family'
      : /情侣|浪漫/.test(text)
        ? 'couple'
        : /朋友|同学/.test(text)
          ? 'friends'
          : null;
  const base = {
    raw_text: text,
    area: parseArea(text),
    duration_minutes: parseDurationMinutes(text),
    budget_cny: parseBudget(text),
    route_mode: routeMode,
    needs_meal: needsMeal,
    meal_type: mealType,
    avoid_queue: /不想排队|少排队|排队少|别排队|低排队/.test(text),
    walk_preference: (/少走路|少步行|别太累|轻松|老人|长辈|亲子|带娃/.test(text) ? 'low' : 'medium') as TravelWalkPreference,
    persona,
    indoor_preferred: /室内|雨天|下雨|博物馆|美术馆|展览/.test(text),
    must_include_names: parseNamesAfter(text, /(?:必须去|一定去|想去|保留)([^，,。；;]+)/g),
    exclude_names: parseNamesAfter(text, /(?:不去|别去|不要去|去掉|排除|删除|取消)([^，,。；;]+)/g),
    replan_action: inferReplanAction(text),
  };
  const missing = missingFieldsFor(base);
  const knownSignals = [
    base.area,
    base.duration_minutes,
    base.budget_cny,
    base.needs_meal,
    base.avoid_queue,
    base.walk_preference === 'low',
    base.persona,
    base.indoor_preferred,
    base.replan_action,
  ].filter(Boolean).length;
  return {
    ...base,
    parser: 'dictionary',
    model: null,
    llm_used: false,
    llm_attempted: false,
    llm_error: null,
    llm_elapsed_ms: 0,
    cache_hit: false,
    cache_layer: null,
    confidence: missing.length === 0 ? 0.9 : Math.max(0.45, Math.min(0.72, 0.42 + knownSignals * 0.06)),
    missing_fields: missing,
    notes: ['Dictionary parser extracted common Beijing travel constraints.'],
  };
}

function shouldUseMiniMax(intent: TravelQueryIntent): boolean {
  return intent.missing_fields.length > 0 || intent.confidence < 0.75 || /吃点|找点吃的|顺便|别太商业|轻松逛逛|随便逛/.test(intent.raw_text);
}

function getMiniMaxConfig() {
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.minimaxi.com/anthropic';
  const token = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  const model = process.env.ANTHROPIC_MODEL?.trim() || 'MiniMax-M2.7';
  const timeoutMs = Number(process.env.TRAVELPILOT_INTENT_TIMEOUT_MS || 5000);
  if (!token) {
    throw new TravelIntentError('MiniMax intent parsing requires ANTHROPIC_AUTH_TOKEN.', 503, 'missing_config');
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    token,
    model,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000,
  };
}

function buildMiniMaxPrompt(rawText: string): string {
  return [
    '你是北京旅游 Agent 的语义兜底解析器。只把用户自然语言解析成 JSON object。',
    '禁止输出 Markdown、解释、SQL、路线方案、POI 推荐、实时排队、实时地图、实时营业状态。',
    '缺少区域或时长时填 null，并把字段名写入 missing_fields。',
    '字段和取值必须严格如下：',
    '{',
    '  "area": string|null,',
    '  "duration_minutes": number|null,',
    '  "budget_cny": number|null,',
    '  "route_mode": "culture"|"mixed",',
    '  "needs_meal": boolean,',
    '  "meal_type": "meal"|"snack"|"coffee"|"dessert"|null,',
    '  "avoid_queue": boolean,',
    '  "walk_preference": "low"|"medium"|"high",',
    '  "persona": "senior"|"family"|"couple"|"friends"|null,',
    '  "indoor_preferred": boolean,',
    '  "must_include_names": string[],',
    '  "exclude_names": string[],',
    '  "replan_action": "add_stop"|"replace_stop"|"remove_stop"|"preserve_route"|"tighten_budget"|null,',
    '  "missing_fields": string[],',
    '  "confidence": number,',
    '  "notes": string[]',
    '}',
    `用户输入：${rawText}`,
  ].join('\n');
}

function extractTextFromAnthropicResponse(payload: unknown): string {
  const content = (payload as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'text') {
          return String((item as { text?: unknown }).text || '');
        }
        return '';
      })
      .join('\n')
      .trim();
  }
  const choiceText =
    (payload as { choices?: Array<{ message?: { content?: unknown }; text?: unknown }> })?.choices?.[0]?.message?.content
    ?? (payload as { choices?: Array<{ text?: unknown }> })?.choices?.[0]?.text
    ?? (payload as { output_text?: unknown })?.output_text;
  return typeof choiceText === 'string' ? choiceText.trim() : '';
}

export function extractJsonObject(modelText: string): unknown {
  const text = String(modelText || '').trim();
  if (!text) {
    throw new TravelIntentError('MiniMax returned an empty intent response.', 502, 'non_json');
  }
  if (/\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i.test(text)) {
    throw new TravelIntentError('MiniMax returned SQL instead of intent JSON.', 502, 'non_json', { preview: text.slice(0, 240) });
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new TravelIntentError('MiniMax response did not contain a JSON object.', 502, 'non_json', { preview: text.slice(0, 240) });
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    throw new TravelIntentError('MiniMax response JSON could not be parsed.', 502, 'invalid_json', {
      preview: candidate.slice(start, Math.min(end + 1, start + 240)),
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function validateTravelQueryIntent(rawJson: unknown, rawText: string, model: string, elapsedMs: number): TravelQueryIntent {
  const parsed = modelIntentSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new TravelIntentError('MiniMax intent JSON failed schema validation.', 422, 'invalid_schema', {
      issues: parsed.error.issues.slice(0, 8),
    });
  }
  const value: ModelIntent = parsed.data;
  const missing = new Set(value.missing_fields);
  if (!value.area) missing.add('area');
  if (!value.duration_minutes) missing.add('duration_minutes');
  return {
    raw_text: normalizeRawText(rawText),
    area: value.area,
    duration_minutes: value.duration_minutes,
    budget_cny: value.budget_cny,
    route_mode: value.route_mode,
    needs_meal: value.needs_meal,
    meal_type: value.needs_meal ? value.meal_type || 'meal' : null,
    avoid_queue: value.avoid_queue,
    walk_preference: value.walk_preference,
    persona: value.persona,
    indoor_preferred: value.indoor_preferred,
    must_include_names: Array.from(new Set(value.must_include_names)),
    exclude_names: Array.from(new Set(value.exclude_names)),
    replan_action: value.replan_action,
    parser: 'minimax',
    model,
    llm_used: true,
    llm_attempted: true,
    llm_error: null,
    llm_elapsed_ms: elapsedMs,
    cache_hit: false,
    cache_layer: null,
    confidence: value.confidence,
    missing_fields: Array.from(missing),
    notes: value.notes,
  };
}

async function callMiniMaxForTravelIntent(rawText: string, timeoutMs?: number) {
  if (process.env.TRAVELPILOT_INTENT_MOCK_RESPONSE) {
    const model = process.env.ANTHROPIC_MODEL?.trim() || 'MiniMax-M2.7';
    return { text: process.env.TRAVELPILOT_INTENT_MOCK_RESPONSE, model, elapsedMs: 0 };
  }

  const config = getMiniMaxConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? config.timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(`${config.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.token,
        authorization: `Bearer ${config.token}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: Number(process.env.TRAVELPILOT_INTENT_MAX_TOKENS || 1600),
        temperature: 0,
        messages: [{ role: 'user', content: buildMiniMaxPrompt(rawText) }],
      }),
      signal: controller.signal,
    });
    const elapsedMs = Number((performance.now() - started).toFixed(2));
    const payload = await response.json().catch(async () => ({ error: await response.text().catch(() => '') }));
    if (!response.ok) {
      throw new TravelIntentError('MiniMax intent request failed.', response.status >= 500 ? 502 : response.status, 'model_error', {
        status: response.status,
        payload,
      });
    }
    const text = extractTextFromAnthropicResponse(payload);
    if (!text) {
      const stopReason = String((payload as { stop_reason?: unknown })?.stop_reason || 'unknown');
      const contentTypes = Array.isArray((payload as { content?: unknown })?.content)
        ? ((payload as { content?: Array<{ type?: unknown }> }).content || []).map((item) => String(item.type || 'unknown')).join(',')
        : 'none';
      throw new TravelIntentError('MiniMax returned no intent text.', 502, 'non_json', { stop_reason: stopReason, content_types: contentTypes });
    }
    return { text, model: config.model, elapsedMs };
  } catch (error) {
    if (error instanceof TravelIntentError) throw error;
    if ((error as { name?: string })?.name === 'AbortError') {
      throw new TravelIntentError('MiniMax intent request timed out.', 504, 'timeout');
    }
    throw new TravelIntentError('MiniMax intent request failed.', 502, 'model_error', {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function parseMiniMaxIntent(rawText: string, options: TravelIntentParseOptions): Promise<TravelQueryIntent> {
  const response = await callMiniMaxForTravelIntent(rawText, options.timeoutMs);
  const json = extractJsonObject(response.text);
  return validateTravelQueryIntent(json, rawText, response.model, response.elapsedMs);
}

export async function parseTravelQueryIntentMiniMaxPreferred(rawText: string, options: TravelIntentParseOptions = {}): Promise<TravelQueryIntent> {
  const normalized = normalizeRawText(rawText);
  if (!normalized) {
    throw new TravelIntentError('raw_text is required.', 400, 'invalid_schema');
  }
  const key = cacheKey(normalized);
  const cached = getCachedIntent(key);
  if (cached) return cached;

  const dictionaryIntent = parseDictionaryIntent(normalized);
  try {
    const minimaxIntent = await parseMiniMaxIntent(normalized, options);
    setCachedIntent(key, minimaxIntent);
    return minimaxIntent;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const fallback = buildClarificationIntent(normalized, [
      `MiniMax preferred parse unavailable: ${errorMessage}`,
      'Fell back to dictionary/clarification intent for route planning.',
    ]);
    fallback.llm_attempted = true;
    fallback.llm_error = errorMessage;
    setCachedIntent(key, fallback);
    return fallback;
  }
}

export async function parseTravelQueryIntent(rawText: string, options: TravelIntentParseOptions = {}): Promise<TravelQueryIntent> {
  const normalized = normalizeRawText(rawText);
  if (!normalized) {
    throw new TravelIntentError('raw_text is required.', 400, 'invalid_schema');
  }
  const key = cacheKey(normalized);
  const cached = getCachedIntent(key);
  if (cached) return cached;

  const dictionaryIntent = parseDictionaryIntent(normalized);
  if (!shouldUseMiniMax(dictionaryIntent)) {
    setCachedIntent(key, dictionaryIntent);
    return dictionaryIntent;
  }

  try {
    const minimaxIntent = await parseMiniMaxIntent(normalized, options);
    setCachedIntent(key, minimaxIntent);
    return minimaxIntent;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (dictionaryIntent.confidence >= 0.55 || dictionaryIntent.missing_fields.length > 0) {
      const fallback = buildClarificationIntent(normalized, [
        `MiniMax fallback unavailable: ${errorMessage}`,
        'Returned dictionary intent for clarification without using generated SQL.',
      ]);
      fallback.llm_attempted = true;
      fallback.llm_error = errorMessage;
      setCachedIntent(key, fallback);
      return fallback;
    }
    throw error;
  }
}

export function intentToPlannerLikeRequest(intent: TravelQueryIntent) {
  const personaId =
    intent.persona === 'family'
      ? 'family_kids'
      : intent.persona === 'senior'
        ? 'senior_relaxed'
        : intent.persona === 'couple'
          ? 'couple_romantic'
          : 'classic_first_timer';

  return {
    goal: intent.raw_text,
    route_mode: intent.route_mode,
    area: intent.area,
    max_budget: intent.budget_cny,
    max_duration_min: intent.duration_minutes,
    walk_preference: intent.walk_preference,
    persona_id: personaId,
    must_include_names: intent.must_include_names,
    exclude_names: intent.exclude_names,
    preference_signals: {
      lunch: intent.needs_meal,
      avoid_queue: intent.avoid_queue,
      family: intent.persona === 'family',
      senior: intent.persona === 'senior',
      couple: intent.persona === 'couple',
      value_for_money: Boolean(intent.budget_cny),
      indoor: intent.indoor_preferred,
    },
  };
}
