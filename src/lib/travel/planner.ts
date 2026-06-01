import fs from 'fs/promises';
import path from 'path';

type JsonRecord = Record<string, any>;
type RouteMode = 'culture' | 'mixed';
type WalkPreference = 'low' | 'medium' | 'high';
type Pace = 'relaxed' | 'balanced' | 'compact';
type Strategy = 'balanced' | 'budget' | 'efficient';
type MealType = 'meal' | 'snack' | 'coffee' | 'dessert' | 'hotel_dining' | 'invalid' | 'non_food';

export interface TravelPlanningRequest {
  goal?: string;
  route_mode?: RouteMode;
  area?: string | null;
  categories?: string[];
  start_time?: string;
  max_budget?: number | null;
  max_total_pois?: number;
  max_duration_min?: number | null;
  day_count?: number;
  pace?: Pace;
  walk_preference?: WalkPreference;
  persona_id?: string;
  must_include_names?: string[];
  exclude_names?: string[];
  must_include_poi_ids?: string[];
  exclude_poi_ids?: string[];
  preference_signals?: Record<string, boolean>;
}

interface Poi extends JsonRecord {
  poi_id: string;
  name: string;
  district?: string;
  area?: string;
  category?: string;
  poi_type?: string;
  address?: string;
  lng: number;
  lat: number;
  rating?: number;
  avg_cost?: number;
  review_count?: number;
  open_time?: string;
  close_time?: string;
  suggested_duration_min?: number;
  planning_tags?: string[];
  evidence_tags?: string[];
  queue_risk?: string;
  value_for_money?: string;
  family_friendliness?: string;
  environment_quality?: string;
  meal_type?: MealType;
  is_lunch_suitable?: boolean;
  is_coffee_stop?: boolean;
  is_meal_stop?: boolean;
}

interface ReviewAggregate extends JsonRecord {
  poi_id: string;
  feature_key: string;
  feature_value: string;
  status: string;
  confidence?: number;
  evidence_refs?: string[];
  review_count_used?: number;
}

interface ReviewRecord extends JsonRecord {
  review_id: string;
  poi_id: string;
  review_text: string;
}

interface TravelData {
  culturePois: Poi[];
  mixedPois: Poi[];
  plannerEntities: Poi[];
  reviewAggregates: ReviewAggregate[];
  reviewRecordsById: Map<string, ReviewRecord>;
}

const DEFAULT_DATA_ROOT = path.resolve(process.cwd(), 'travel-data', 'processed');
const DATA_ROOT = process.env.TRAVELPILOT_DATA_ROOT || DEFAULT_DATA_ROOT;

let dataCache: Promise<TravelData> | null = null;

async function readJsonArray<T>(fileName: string): Promise<T[]> {
  const content = await fs.readFile(path.join(DATA_ROOT, fileName), 'utf8');
  const parsed = JSON.parse(content);
  return Array.isArray(parsed) ? parsed as T[] : [];
}

function hasAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function normalizeUserTravelText(text: string): string {
  return String(text || '').trim().replace(/^[/／\\]+\s*/, '').trim();
}

function deriveMealSemantics(raw: Partial<Poi>) {
  const name = String(raw.name || '');
  const lowerName = name.toLowerCase();
  const metadata = [
    raw.category,
    raw.poi_type,
    raw.poi_subtype,
    raw.dining_style,
    ...(Array.isArray(raw.planning_tags) ? raw.planning_tags : []),
    ...(Array.isArray(raw.evidence_tags) ? raw.evidence_tags : []),
  ].map((value) => String(value || '').toLowerCase()).join(' ');

  const coffeeWords = ['咖啡', 'coffee', 'cafe', '星巴克', '瑞幸'];
  const mealWords = ['餐', '饭', '面', '涮肉', '烧麦', '烤鸭', '饺子', '炸酱', '炒肝', '火锅', '串', '食'];
  const snackWords = ['小吃', '麦当劳', '肯德基', '包子', '驴打滚', '糕', '饼'];
  const dessertWords = ['甜品', '下午茶', '茶饮', '奶茶'];
  const hotelWords = ['酒店', '宾馆', '漫心府', '亚朵', '主题酒店'];
  const scenicWords = ['公园', '博物院', '博物馆', '步行街', '景区', '景点', '寺', '殿', '塔', '后海', '前海', '鼓楼', '艺术中心', '探索中心'];

  const hasDiningMetadata = /(^|\s)(dining|food|restaurant|meal|lunch|dinner|snack|cafe|coffee)(\s|$)/.test(metadata);
  const coffee = hasAny(lowerName, coffeeWords);
  const mealName = hasAny(name, mealWords);
  const snackName = hasAny(name, snackWords);
  const dessertName = hasAny(name, dessertWords);
  const hotelName = hasAny(name, hotelWords);
  const scenicName = hasAny(name, scenicWords) || name === '什刹海';

  if (scenicName && !mealName && !snackName && !coffee && !dessertName) {
    return { meal_type: 'invalid' as MealType, is_lunch_suitable: false, is_coffee_stop: false, is_meal_stop: false };
  }
  if (!hasDiningMetadata && !mealName && !snackName && !coffee && !dessertName) {
    return { meal_type: 'non_food' as MealType, is_lunch_suitable: false, is_coffee_stop: false, is_meal_stop: false };
  }
  if (hotelName && !mealName && !snackName) {
    return { meal_type: 'hotel_dining' as MealType, is_lunch_suitable: false, is_coffee_stop: false, is_meal_stop: false };
  }
  if (coffee) {
    return { meal_type: 'coffee' as MealType, is_lunch_suitable: false, is_coffee_stop: true, is_meal_stop: true };
  }
  if (dessertName && !mealName && !snackName) {
    return { meal_type: 'dessert' as MealType, is_lunch_suitable: false, is_coffee_stop: false, is_meal_stop: true };
  }
  if (snackName) {
    return { meal_type: 'snack' as MealType, is_lunch_suitable: true, is_coffee_stop: false, is_meal_stop: true };
  }
  return { meal_type: 'meal' as MealType, is_lunch_suitable: true, is_coffee_stop: false, is_meal_stop: true };
}

function normalizePoi(raw: Poi): Poi {
  const name = String(raw.name || raw.display_name || raw.normalized_name || raw.poi_id);
  const meal = deriveMealSemantics({ ...raw, name });
  return {
    ...raw,
    poi_id: String(raw.poi_id),
    name,
    lng: Number(raw.lng),
    lat: Number(raw.lat),
    rating: Number(raw.rating || 0),
    avg_cost: Number(raw.avg_cost || 0),
    review_count: Number(raw.review_count || 0),
    suggested_duration_min: Number(raw.suggested_duration_min || raw.avg_visit_duration_min || 90),
    poi_type: meal.is_meal_stop || meal.is_coffee_stop ? 'food' : 'culture',
    ...meal,
  };
}

async function loadTravelData(): Promise<TravelData> {
  if (!dataCache) {
    dataCache = Promise.all([
      readJsonArray<Poi>('beijing_culture_pois.json'),
      readJsonArray<Poi>('beijing_mixed_category_pois.json'),
      readJsonArray<Poi>('beijing_planner_entities.json'),
      readJsonArray<ReviewAggregate>('beijing_poi_feature_aggregates.json'),
      readJsonArray<ReviewRecord>('beijing_review_records.json'),
    ]).then(([culturePois, mixedPois, plannerEntities, reviewAggregates, reviewRecords]) => ({
      culturePois: culturePois.map(normalizePoi),
      mixedPois: mixedPois.map(normalizePoi),
      plannerEntities: plannerEntities.map(normalizePoi),
      reviewAggregates,
      reviewRecordsById: new Map(reviewRecords.map((item) => [String(item.review_id), item])),
    }));
  }
  return dataCache;
}

function normalizePoiName(name?: string): string {
  return String(name || '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/[-—·\s]/g, '')
    .trim()
    .toLowerCase();
}

function extractExcludedNames(text: string): string[] {
  const names: string[] = [];
  const normalizedText = normalizeUserTravelText(text);
  const pattern = /(?:不去|别去|不要去?|去掉|排除|取消|避开|别安排|不要安排)([^，,。；;]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalizedText)) !== null) {
    const raw = String(match[1] || '')
      .replace(/^(这个|那个|这里|那里|它|他|她)/, '')
      .replace(/^(地方|地点|景点|餐厅|饭店|点位|这个地方|那个地方|这个景点|那个景点)/, '')
      .replace(/^(了|吧|呀|啊|呢)/, '')
      .trim();
    if (!raw) continue;
    if (/^(吃饭|午餐|午饭|晚餐|餐饮|饭|餐)$/.test(raw)) continue;
    for (const part of raw.split(/[、和]/).map((item) => item.trim()).filter(Boolean)) {
      names.push(part);
    }
  }
  return Array.from(new Set(names));
}

function matchesExcludedName(item: Pick<Poi, 'name'>, excludedNames: string[]): boolean {
  const name = normalizePoiName(item.name);
  return excludedNames.some((excluded) => {
    const normalizedExcluded = normalizePoiName(excluded);
    return Boolean(normalizedExcluded && (name.includes(normalizedExcluded) || normalizedExcluded.includes(name)));
  });
}

function uniqueByName(items: Poi[]): Poi[] {
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  return items.filter((item) => {
    const name = normalizePoiName(item.name);
    if (seenIds.has(item.poi_id) || seenNames.has(name)) return false;
    seenIds.add(item.poi_id);
    if (name) seenNames.add(name);
    return true;
  });
}

function isFoodPoi(item: Poi): boolean {
  return Boolean(item.is_meal_stop || item.is_coffee_stop);
}

function isLunchPoi(item: Poi): boolean {
  return Boolean(item.is_lunch_suitable);
}

function isCoffeePoi(item: Poi): boolean {
  return Boolean(item.is_coffee_stop);
}

function mealQualityScore(item: Poi): number {
  let score = 0;
  if (item.meal_type === 'meal') score += 12;
  if (item.meal_type === 'snack') score += 10;
  if (item.meal_type === 'coffee') score -= 6;
  if (item.meal_type === 'dessert') score -= 8;
  if (item.meal_type === 'hotel_dining' || item.meal_type === 'invalid') score -= 20;
  if (Number(item.avg_cost || 0) > 0) score += 3;
  return score;
}

function adjustmentWantsFreshPlan(text: string): boolean {
  return /全新|重新来|不保留|重新安排所有|全部重排/.test(text);
}

function adjustmentWantsFoodChange(text: string): boolean {
  return /(午餐|午饭|中午吃|吃饭|餐饮|餐厅|饭店|小吃|咖啡|正餐|美食|把午餐|换午餐|午餐换|换成.*(?:午餐|午饭|小吃|咖啡|餐厅|饭店|正餐|美食)|改成.*(?:午餐|午饭|小吃|咖啡|餐厅|饭店|正餐|美食))/.test(text);
}

function adjustmentWantsSnack(text: string): boolean {
  return /小吃|预算\s*\d+\s*以内的小吃|换成.*小吃/.test(text);
}

function parseTargetedReplacementIndex(text: string, total: number): number | null {
  if (!total || !/(换成|换一个|替换|改成|更换)/.test(text)) return null;
  if (/最后一个|最后1个|末尾|最后一站|最后1站/.test(text)) return total - 1;
  const chineseNumbers: Record<string, number> = {
    一: 0,
    二: 1,
    两: 1,
    三: 2,
    四: 3,
    五: 4,
    六: 5,
  };
  const chineseMatch = text.match(/第\s*([一二两三四五六])\s*(?:个|站|处)?(?:点|景点|地点|餐厅|饭店|POI)?/);
  if (chineseMatch?.[1] && chineseMatch[1] in chineseNumbers) {
    const index = chineseNumbers[chineseMatch[1]];
    return index >= 0 && index < total ? index : null;
  }
  const digitMatch = text.match(/第\s*(\d+)\s*(?:个|站|处)?(?:点|景点|地点|餐厅|饭店|POI)?/i);
  if (digitMatch?.[1]) {
    const index = Number(digitMatch[1]) - 1;
    return index >= 0 && index < total ? index : null;
  }
  return null;
}

function shouldPreservePoiOnReplan(params: {
  poi: Poi;
  adjustmentText: string;
  excludedNames: string[];
  excludedIds: Set<string>;
}): boolean {
  if (params.excludedIds.has(params.poi.poi_id)) return false;
  if (matchesExcludedName(params.poi, params.excludedNames)) return false;
  if (adjustmentWantsFreshPlan(params.adjustmentText)) return false;
  if (adjustmentWantsFoodChange(params.adjustmentText) && isFoodPoi(params.poi)) return false;
  return true;
}

function normalizeRequest(payload: Partial<TravelPlanningRequest>): TravelPlanningRequest {
  return {
    goal: String(payload.goal || ''),
    route_mode: payload.route_mode === 'culture' ? 'culture' : 'mixed',
    area: payload.area || null,
    categories: Array.isArray(payload.categories) ? payload.categories : [],
    start_time: payload.start_time || '09:00',
    max_budget: payload.max_budget === undefined ? null : payload.max_budget,
    max_total_pois: Math.max(3, Math.min(6, Number(payload.max_total_pois || 4))),
    max_duration_min: payload.max_duration_min === undefined ? null : payload.max_duration_min,
    day_count: Math.max(1, Math.min(5, Number(payload.day_count || 1))),
    pace: payload.pace || 'balanced',
    walk_preference: payload.walk_preference || 'medium',
    persona_id: payload.persona_id || 'classic_first_timer',
    must_include_names: Array.isArray(payload.must_include_names) ? payload.must_include_names : [],
    exclude_names: Array.isArray(payload.exclude_names) ? payload.exclude_names : [],
    must_include_poi_ids: Array.isArray(payload.must_include_poi_ids) ? payload.must_include_poi_ids : [],
    exclude_poi_ids: Array.isArray(payload.exclude_poi_ids) ? payload.exclude_poi_ids : [],
    preference_signals: payload.preference_signals || {},
  };
}

function parseGoal(goal: string, defaults: Partial<TravelPlanningRequest> = {}): TravelPlanningRequest {
  const compactGoal = goal.replace(/\s+/g, '');
  const wantsCouple = /情侣|约会|恋人|浪漫|两个人|二人/.test(goal);
  const wantsSenior = /老人|长辈|父母|爸妈|老年|别太累/.test(goal);
  const wantsKids = /亲子|孩子|小孩|儿童|带娃|遛娃|家庭/.test(goal);
  const noFood = /不吃饭|不安排吃饭|不要吃饭|不用吃饭/.test(goal);
  const explicitCulture = /文化路线|文化景点|经典文化/.test(goal);
  const asksFood = !noFood && /吃|饭|餐|美食|午餐|午饭|晚餐|咖啡|喝咖啡|烤鸭|炸酱面|小吃|吃逛|每天安排吃饭/.test(goal);
  const asksLunch = !noFood && !/晚上|夜间|夜游|晚餐/.test(goal) && /中午|午餐|午饭|午间|每天安排吃饭/.test(goal);
  const routeMode: RouteMode = noFood || (explicitCulture && !asksFood) ? 'culture' : defaults.route_mode ?? (asksFood ? 'mixed' : 'culture');
  const areas = ['前门', '故宫', '什刹海', '南锣鼓巷', '王府井', '天坛', '天安门', '西单', '地坛', '建国门', '宣武门', '北海', '景山'];
  const budgetMatch = goal.match(/预算(?:降到|控制在|不超|不超过|以内)?(\d+)/) ?? goal.match(/(\d+)元?(?:以内|以下|内)/);
  const durationMatch = goal.match(/(\d+(?:\.\d+)?)(?:个)?小时/);
  const dayMatch = goal.match(/(\d+)(?:天|日)/);
  const poiMatch = goal.match(/(\d+)(?:个|处|站|家)?(?:POI|点|景点|地方)/i);
  const parsedExcludedNames = extractExcludedNames(goal);
  const dayCount = dayMatch?.[1] ? Number(dayMatch[1]) : /一日|一天|整天|全天/.test(goal) ? 1 : /两天|二天|两日|二日/.test(goal) ? 2 : defaults.day_count ?? 1;
  const maxDuration = durationMatch?.[1]
    ? Math.round(Number(durationMatch[1]) * 60)
    : /半日|半天/.test(goal)
      ? 4 * 60
      : defaults.max_duration_min ?? (dayCount >= 1 && /(天|日|整天|全天)/.test(goal) ? 8 * 60 : null);
  const excludeNames = [...(defaults.exclude_names || [])];
  excludeNames.push(...parsedExcludedNames);
  const coffeeWanted = /咖啡|喝咖啡/.test(goal) && !/(去掉|不要|排除)[^，,。；;]*咖啡/.test(goal);
  const inheritedSignals = defaults.preference_signals || {};
  const personaId = wantsKids
    ? 'family_kids'
    : wantsSenior
      ? 'senior_relaxed'
      : wantsCouple
        ? 'couple_romantic'
        : defaults.persona_id ?? 'classic_first_timer';

  return normalizeRequest({
    ...defaults,
    goal,
    route_mode: routeMode,
    area: areas.find((item) => compactGoal.includes(item)) ?? defaults.area ?? null,
    start_time: defaults.start_time ?? (/晚上|夜间|夜游|晚餐/.test(goal) ? '18:00' : asksLunch && maxDuration && maxDuration <= 300 ? '10:00' : undefined),
    max_budget: budgetMatch?.[1] ? Number(budgetMatch[1]) : defaults.max_budget ?? null,
    max_duration_min: maxDuration,
    max_total_pois: poiMatch?.[1] ? Number(poiMatch[1]) : defaults.max_total_pois ?? (maxDuration && maxDuration <= 270 ? 3 : dayCount > 1 ? 4 : 4),
    day_count: dayCount,
    persona_id: personaId,
    walk_preference: /少走路|少步行|别太累|老人|轻松|长辈|父母|带娃|亲子|孩子|小孩/.test(goal) ? 'low' : defaults.walk_preference ?? 'medium',
    pace: /紧凑|多逛|效率/.test(goal) ? 'compact' : /轻松|慢|老人|长辈|父母|带娃|亲子|孩子|小孩|别太累/.test(goal) ? 'relaxed' : defaults.pace ?? 'balanced',
    exclude_names: excludeNames,
    preference_signals: {
      avoid_queue: /不想排队|少排队|排队/.test(goal) || Boolean(inheritedSignals.avoid_queue),
      value_for_money: /性价比|预算|便宜|实惠/.test(goal) || Boolean(inheritedSignals.value_for_money),
      family: wantsKids || Boolean(inheritedSignals.family),
      senior: wantsSenior || Boolean(inheritedSignals.senior),
      couple: wantsCouple || Boolean(inheritedSignals.couple),
      lunch: asksLunch || Boolean(inheritedSignals.lunch),
      coffee: coffeeWanted,
    },
  });
}

function meters(a: Poi, b: Poi): number {
  const rad = Math.PI / 180;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function transferMinutes(distanceMeters: number): number {
  return Math.max(4, Math.round(distanceMeters / 70));
}

function parseMinutes(value?: string): number | null {
  if (!value) return null;
  const match = String(value).match(/(\d{1,2}):?(\d{2})?/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2] || 0);
}

function minutesToTime(total: number): string {
  const normalized = ((total % 1440) + 1440) % 1440;
  return `${Math.floor(normalized / 60).toString().padStart(2, '0')}:${(normalized % 60).toString().padStart(2, '0')}`;
}

function aggregateMap(data: TravelData, poiId: string) {
  const claims = data.reviewAggregates.filter((item) => item.poi_id === poiId);
  const values = Object.fromEntries(claims.map((item) => [item.feature_key, item.feature_value]));
  return { claims, values };
}

function poiText(item: Poi): string {
  return [
    item.name,
    item.category,
    item.poi_type,
    item.family_friendliness,
    ...(Array.isArray(item.planning_tags) ? item.planning_tags : []),
    ...(Array.isArray(item.evidence_tags) ? item.evidence_tags : []),
  ].map((value) => String(value || '').toLowerCase()).join(' ');
}

function scorePoi(item: Poi, request: TravelPlanningRequest, strategy: Strategy, data: TravelData): number {
  const { values } = aggregateMap(data, item.poi_id);
  let score = Number(item.rating || 0) * 12 + Math.min(Number(item.review_count || 0), 500) / 100;
  const cost = Number(item.avg_cost || 0);
  const duration = Number(item.suggested_duration_min || 90);
  const text = poiText(item);
  if (strategy === 'budget') score -= cost / 8;
  else score -= cost / 25;
  if (strategy === 'efficient') score -= duration / 5;
  else score -= duration / 14;
  if (request.preference_signals?.avoid_queue && values.queue_risk === 'low') score += 10;
  if (request.preference_signals?.avoid_queue && values.queue_risk === 'high') score -= 18;
  if (request.preference_signals?.value_for_money && values.value_for_money === 'high') score += 8;
  if (request.preference_signals?.family && values.family_friendliness === 'high') score += 8;
  if (values.environment_quality === 'high') score += 2;
  if (request.walk_preference === 'low' && item.walk_intensity === 'high') score -= 8;
  if (request.preference_signals?.lunch && isFoodPoi(item) && !isLunchPoi(item)) score -= 20;

  if (request.persona_id === 'couple_romantic' || request.preference_signals?.couple) {
    if (/coffee|cafe|咖啡|甜品|下午茶/.test(text)) score += 14;
    if (/art|gallery|美术|艺术|展览|theater|剧场|电影|音乐|scene:indoor/.test(text)) score += 9;
    if (/park|公园|什刹海|后海|前海|夜景|landmark/.test(text)) score += 4;
    if (/family|儿童|亲子/.test(text)) score -= 8;
  }

  if (request.persona_id === 'senior_relaxed' || request.preference_signals?.senior) {
    if (item.walk_intensity === 'low' || /walk:low/.test(text)) score += 14;
    if (/need:short_stop|need:indoor_backup|scene:indoor|rain_friendly|low_stress/.test(text)) score += 8;
    if (/museum|博物馆|美术|艺术|公园|attraction|景点/.test(text)) score += 6;
    if (/family|children|儿童|亲子|妇女儿童|scene:family/.test(text)) score -= 16;
    if (item.walk_intensity === 'medium') score -= 6;
    if (item.walk_intensity === 'high') score -= 18;
    if (cost > 180) score -= 10;
  }

  if (request.persona_id === 'family_kids' || request.preference_signals?.family) {
    if (values.family_friendliness === 'high' || item.family_friendliness === 'high') score += 18;
    if (/family|children|儿童|亲子|科技|自然|museum|博物馆|low_stress|scene:family/.test(text)) score += 12;
    if (/coffee|cafe|咖啡/.test(text) && request.preference_signals?.lunch) score -= 12;
    if (item.walk_intensity === 'low' || /walk:low/.test(text)) score += 6;
    if (item.walk_intensity === 'high') score -= 14;
  }
  return score;
}

function selectArea(request: TravelPlanningRequest, candidates: Poi[]): string {
  if (request.area && candidates.some((item) => item.area === request.area || item.district === request.area)) return request.area;
  const counts = new Map<string, number>();
  for (const item of candidates) {
    const area = item.area && item.area !== '未知' ? item.area : item.district || '故宫';
    counts.set(area, (counts.get(area) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '故宫';
}

function selectPopularAreas(candidates: Poi[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const item of candidates) {
    const area = item.area && !String(item.area).includes('未知') ? item.area : item.district;
    if (!area || String(area).includes('未知')) continue;
    counts.set(area, (counts.get(area) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([area]) => area).slice(0, Math.max(1, limit));
}

function orderNearest(items: Poi[]): Poi[] {
  if (items.length <= 2) return items;
  const remaining = [...items];
  const ordered = [remaining.shift()!];
  while (remaining.length) {
    const last = ordered[ordered.length - 1];
    let bestIndex = 0;
    let bestDistance = Infinity;
    remaining.forEach((item, index) => {
      const distance = meters(last, item);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    ordered.push(remaining.splice(bestIndex, 1)[0]);
  }
  return ordered;
}

function buildStopEvidence(item: Poi, data: TravelData) {
  const { claims, values } = aggregateMap(data, item.poi_id);
  const topEvidence = claims.slice(0, 4).map((claim) => {
    const refs = Array.isArray(claim.evidence_refs) ? claim.evidence_refs : [];
    const review = refs.map((ref) => data.reviewRecordsById.get(String(ref))).find(Boolean);
    return {
      feature_key: claim.feature_key,
      feature_value: claim.feature_value,
      status: claim.status,
      confidence: claim.confidence ?? null,
      review_text: review?.review_text || null,
    };
  });
  return {
    signals: {
      queue_risk: values.queue_risk || item.queue_risk || 'unavailable',
      value_for_money: values.value_for_money || item.value_for_money || 'unavailable',
      family_friendliness: values.family_friendliness || item.family_friendliness || 'unavailable',
      environment_quality: values.environment_quality || item.environment_quality || 'unavailable',
    },
    evidence_review_count: claims.reduce((sum, claim) => sum + Number(claim.review_count_used || 0), 0),
    top_evidence: topEvidence,
    confidence_note: topEvidence.length ? 'UGC signals are aggregated from local review features.' : 'No local review evidence for this POI yet.',
  };
}

function buildReason(item: Poi, request: TravelPlanningRequest, data: TravelData): string {
  const { values } = aggregateMap(data, item.poi_id);
  const parts = [`${item.area || item.district || '北京'} area`, `rating ${Number(item.rating || 0).toFixed(1)}`, `stay about ${Number(item.suggested_duration_min || 90)} min`];
  if (request.preference_signals?.avoid_queue && values.queue_risk) parts.push(`queue ${values.queue_risk}`);
  if (request.preference_signals?.value_for_money && values.value_for_money) parts.push(`value ${values.value_for_money}`);
  if (item.meal_type && item.meal_type !== 'non_food') parts.push(`meal type ${item.meal_type}`);
  return parts.join('; ');
}

function translateRisk(risk: unknown): string {
  const text = String(risk || '');
  if (text.includes('Estimated budget')) {
    const match = text.match(/Estimated budget (\d+) exceeds requested (\d+)/);
    return match ? `预算估算 ${match[1]} 元，超过用户要求 ${match[2]} 元。` : '预算估算超过用户要求。';
  }
  if (text.includes('Estimated route duration')) {
    const match = text.match(/Estimated route duration is (\d+) minutes, above requested (\d+)/);
    return match ? `路线总时长估算 ${match[1]} 分钟，超过用户要求 ${match[2]} 分钟。` : '路线总时长超过用户要求。';
  }
  if (text.includes('opening-hours data')) return '部分点位可能与本地营业时间数据冲突。';
  if (text.includes('complete opening-hours coverage')) {
    const match = text.match(/(\d+) stop/);
    return `${match?.[1] || '部分'} 个点位缺少完整营业时间覆盖。`;
  }
  if (text.includes('Walking distance')) return '步行距离和转移时间为本地坐标估算，不代表实时导航。';
  return text;
}

function candidatePool(data: TravelData, request: TravelPlanningRequest): Poi[] {
  const source = request.route_mode === 'culture' ? data.culturePois : data.plannerEntities.length ? data.plannerEntities : data.mixedPois;
  return source.filter((item) => Number.isFinite(item.lng) && Number.isFinite(item.lat));
}

function buildProposal(params: {
  request: TravelPlanningRequest;
  strategy: Strategy;
  selectedArea: string;
  candidates: Poi[];
  data: TravelData;
}) {
  const { request, strategy, selectedArea, candidates, data } = params;
  const targetCount = Math.max(3, request.max_total_pois || 4);
  const sameArea = candidates.filter((item) => item.area === selectedArea || item.district === selectedArea);
  const pool = uniqueByName(sameArea.length >= 3 ? sameArea : candidates);
  const excludedIds = new Set(request.exclude_poi_ids || []);
  const excludedNames = (request.exclude_names || []).map(normalizePoiName);
  const available = pool.filter((item) => {
    if (excludedIds.has(item.poi_id)) return false;
    return !matchesExcludedName(item, request.exclude_names || []);
  }).filter((item) => !String(item.poi_id).startsWith('fixture_') && !String(item.name).includes('未知'));

  const food = available.filter(isFoodPoi);
  const lunchFood = food.filter(isLunchPoi);
  const culture = available.filter((item) => !isFoodPoi(item));
  const ranked = (items: Poi[]) => [...items]
    .filter((item) => request.max_budget === null || request.max_budget === undefined || Number(item.avg_cost || 0) <= Number(request.max_budget))
    .sort((a, b) => scorePoi(b, request, strategy, data) - scorePoi(a, request, strategy, data));
  const foodRanked = (items: Poi[]) => ranked(items).sort((a, b) => {
    if (request.preference_signals?.coffee) {
      const aCoffee = isCoffeePoi(a) ? 1 : 0;
      const bCoffee = isCoffeePoi(b) ? 1 : 0;
      if (aCoffee !== bCoffee) return bCoffee - aCoffee;
    }
    if (request.preference_signals?.lunch) {
      const quality = mealQualityScore(b) - mealQualityScore(a);
      if (quality !== 0) return quality;
    }
    return 0;
  });

  const selected: Poi[] = [];
  if (request.route_mode === 'mixed') {
    const budgetLimit = request.max_budget === null || request.max_budget === undefined ? null : Number(request.max_budget);
    const mealPool = request.preference_signals?.lunch ? lunchFood : food;
    const lockedCultureCost = available
      .filter((item) => (request.must_include_poi_ids || []).includes(item.poi_id) && !isFoodPoi(item))
      .reduce((sum, item) => sum + Number(item.avg_cost || 0), 0);
    const foodBudgetCap = budgetLimit === null ? null : Math.max(0, budgetLimit - lockedCultureCost);
    const foodCandidates = budgetLimit
      ? foodRanked(mealPool).filter((item) => Number(item.avg_cost || 0) <= Math.max(0, foodBudgetCap ?? budgetLimit))
      : foodRanked(mealPool);
    const selectedFood = foodCandidates[0] ?? foodRanked(mealPool)[0] ?? foodRanked(food)[0];
    if (selectedFood) selected.push(selectedFood);
    const remainingBudget = budgetLimit === null ? null : Math.max(0, budgetLimit - Number(selectedFood?.avg_cost || 0));
    const cultureSlots = Math.max(2, targetCount - 1);
    const cultureBudgetCap = remainingBudget === null ? null : Math.max(0, remainingBudget / cultureSlots);
    const cultureDurationCap = request.persona_id === 'family_kids' || request.persona_id === 'senior_relaxed' ? 120 : 100;
    const cultureCandidates = ranked(culture)
      .filter((item) => Number(item.suggested_duration_min || 90) <= cultureDurationCap)
      .filter((item) => cultureBudgetCap === null || Number(item.avg_cost || 0) <= cultureBudgetCap);
    selected.push(...cultureCandidates.slice(0, cultureSlots));
    if (selected.length < targetCount) {
      selected.push(...ranked(culture).filter((item) => !selected.some((chosen) => chosen.poi_id === item.poi_id)).slice(0, targetCount - selected.length));
    }
  } else {
    selected.push(...ranked(culture).slice(0, targetCount));
  }

  const mustIds = new Set(request.must_include_poi_ids || []);
  const mustNames = new Set(request.must_include_names || []);
  for (const required of candidates.filter((item) => {
    if (excludedIds.has(item.poi_id) || matchesExcludedName(item, request.exclude_names || [])) return false;
    return mustIds.has(item.poi_id) || mustNames.has(item.name);
  })) {
    if (!selected.some((item) => item.poi_id === required.poi_id)) selected.unshift(required);
  }

  let ordered = orderNearest(uniqueByName(selected).slice(0, targetCount));
  if (request.route_mode === 'mixed') {
    const cultureStops = ordered.filter((item) => !isFoodPoi(item));
    const foodStops = ordered.filter(isFoodPoi);
    const lunchFirst = request.preference_signals?.lunch && (parseMinutes(request.start_time) ?? 9 * 60) >= 11 * 60;
    ordered = lunchFirst ? [...foodStops, ...cultureStops] : [...cultureStops.slice(0, 1), ...foodStops, ...cultureStops.slice(1)];
  }

  const start = parseMinutes(request.start_time) ?? 9 * 60;
  let cursor = start;
  let totalTransfer = 0;
  let totalDistance = 0;
  let unknownHours = 0;
  let hasOpeningConflict = false;
  const stops = ordered.map((item, index) => {
    let transfer = 0;
    let distance = 0;
    if (index > 0) {
      distance = meters(ordered[index - 1], item);
      transfer = transferMinutes(distance);
      totalTransfer += transfer;
      totalDistance += distance;
      cursor += transfer;
    }
    const isFoodStop = isFoodPoi(item);
    if (request.preference_signals?.lunch && isFoodStop && cursor < 11 * 60 + 30) cursor = 11 * 60 + 30;
    const arrival = cursor;
    const rawStay = Number(item.suggested_duration_min || 90);
    const shortRoute = Boolean(request.max_duration_min && request.max_duration_min <= 270);
    const relaxedLowWalk = request.walk_preference === 'low' && request.pace === 'relaxed';
    const stay = request.max_duration_min && request.max_duration_min <= 180
      ? Math.min(rawStay, isFoodStop ? 35 : 45)
      : shortRoute
        ? Math.min(rawStay, isFoodStop ? 50 : relaxedLowWalk ? 55 : 65)
        : rawStay;
    const open = parseMinutes(item.open_time);
    const close = parseMinutes(item.close_time);
    let openingStatus = 'unknown';
    if (open !== null && close !== null) {
      openingStatus = arrival >= open && arrival + stay <= close ? 'ok' : 'conflict';
      if (openingStatus === 'conflict') hasOpeningConflict = true;
    } else {
      unknownHours += 1;
    }
    cursor += stay;
    return {
      poi_id: item.poi_id,
      name: item.name,
      poi_type: isFoodStop ? 'food' : 'culture',
      category: item.category || 'unknown',
      meal_type: item.meal_type || 'non_food',
      is_lunch_suitable: Boolean(item.is_lunch_suitable),
      is_coffee_stop: Boolean(item.is_coffee_stop),
      area: item.area || item.district || '未知',
      district: item.district || '未知',
      address: item.address || '',
      arrival_time: minutesToTime(arrival),
      departure_time: minutesToTime(cursor),
      stay_minutes: stay,
      transfer_from_previous_minutes: transfer,
      transfer_from_previous_meters: Math.round(distance),
      estimated_cost: Number(item.avg_cost || 0),
      meal_slot: request.preference_signals?.lunch && isFoodStop ? 'lunch' : null,
      rating: Number(item.rating || 0),
      opening_status: openingStatus,
      opening_hours_note: openingStatus === 'unknown' ? '本地数据未覆盖完整营业时间。' : openingStatus === 'ok' ? '按本地营业时间估算可访问。' : '按本地营业时间估算存在冲突。',
      recommendation_reason: buildReason(item, request, data),
      evidence_summary: buildStopEvidence(item, data),
    };
  });

  const totalBudget = stops.reduce((sum, item) => sum + item.estimated_cost, 0);
  const totalVisit = stops.reduce((sum, item) => sum + item.stay_minutes, 0);
  const totalDuration = cursor - start;
  const foodCount = stops.filter((item) => item.poi_type === 'food').length;
  const cultureCount = stops.length - foodCount;
  const risks = [
    request.max_budget !== null && request.max_budget !== undefined && totalBudget > Number(request.max_budget) ? `Estimated budget ${totalBudget} exceeds requested ${request.max_budget}.` : null,
    request.max_duration_min !== null && request.max_duration_min !== undefined && totalDuration > Number(request.max_duration_min) ? `Estimated route duration is ${totalDuration} minutes, above requested ${request.max_duration_min}.` : null,
    hasOpeningConflict ? 'One or more stops may conflict with local opening-hours data.' : null,
    unknownHours ? `${unknownHours} stop(s) do not have complete opening-hours coverage in the local dataset.` : null,
    'Walking distance and transfer time are local estimates, not real-time navigation.',
  ].filter(Boolean).map(translateRisk);
  const title = strategy === 'balanced' ? '均衡体验方案' : strategy === 'budget' ? '预算优先方案' : '效率优先方案';
  return {
    proposal_id: `${strategy}-${Math.random().toString(16).slice(2, 10)}`,
    strategy,
    display_title: title,
    title,
    summary: `${selectedArea} area, ${stops.length} POIs, about ${totalDuration} min, ${totalBudget} CNY.`,
    ordered_poi_ids: stops.map((item) => item.poi_id),
    ordered_poi_names: stops.map((item) => item.name),
    pois: stops,
    total_budget_estimate: totalBudget,
    total_transfer_minutes: totalTransfer,
    total_walking_distance_m: Math.round(totalDistance),
    total_visit_duration_min: totalVisit,
    total_route_duration_min: totalDuration,
    travel_time_confidence: 'estimated',
    budget_summary: { max_budget: request.max_budget, within_budget: request.max_budget === null || request.max_budget === undefined || totalBudget <= Number(request.max_budget), total_budget_estimate: totalBudget },
    duration_summary: { max_duration_min: request.max_duration_min, within_duration: request.max_duration_min === null || request.max_duration_min === undefined || totalDuration <= Number(request.max_duration_min), total_route_duration_min: totalDuration, total_visit_duration_min: totalVisit, total_transfer_minutes: totalTransfer },
    category_coverage_summary: {
      route_mode: request.route_mode,
      food_count: foodCount,
      culture_or_entertainment_count: cultureCount,
      required_food_count: request.route_mode === 'mixed' ? 1 : 0,
      required_culture_or_entertainment_count: request.route_mode === 'mixed' ? 2 : 3,
      satisfies_coverage: request.route_mode === 'mixed' ? foodCount >= 1 && cultureCount >= 2 : cultureCount >= 3,
    },
    opening_hours_check: { has_conflict: hasOpeningConflict, unknown_hours_count: unknownHours },
    risks,
  };
}

export async function travelHealth() {
  const data = await loadTravelData();
  return {
    status: 'ok',
    city_id: 'beijing',
    data_root: DATA_ROOT,
    counts: {
      culture_pois: data.culturePois.length,
      mixed_pois: data.mixedPois.length,
      planner_entities: data.plannerEntities.length,
      review_aggregates: data.reviewAggregates.length,
      review_pois: new Set(data.reviewAggregates.map((item) => item.poi_id)).size,
    },
    limitations: ['No realtime map, realtime queue, or external review API is used.', 'Distance and transfer time are local coordinate estimates.'],
  };
}

export async function travelOptions() {
  const data = await loadTravelData();
  const areas = new Map<string, { culture_count: number; mixed_count: number }>();
  for (const item of data.culturePois) {
    const area = item.area || item.district;
    if (!area || area === '未知') continue;
    areas.set(area, { culture_count: (areas.get(area)?.culture_count || 0) + 1, mixed_count: areas.get(area)?.mixed_count || 0 });
  }
  for (const item of data.plannerEntities) {
    const area = item.area || item.district;
    if (!area || area === '未知') continue;
    areas.set(area, { culture_count: areas.get(area)?.culture_count || 0, mixed_count: (areas.get(area)?.mixed_count || 0) + 1 });
  }
  return {
    city_id: 'beijing',
    route_modes: [
      { value: 'culture', label: '北京文化路线' },
      { value: 'mixed', label: '餐饮 + 文化混排' },
    ],
    areas: [...areas.entries()].map(([value, counts]) => ({ value, label: value, ...counts })).sort((a, b) => b.mixed_count - a.mixed_count).slice(0, 30),
    walk_options: [
      { value: 'low', label: '少走路' },
      { value: 'medium', label: '可接受步行' },
      { value: 'high', label: '愿意多走' },
    ],
    demo_goals: [
      '前门附近玩4小时，中午吃饭，想吃好但不想排队，预算200以内，少走路',
      '故宫附近安排4小时文化路线，少走路，预算100以内，不吃饭',
      '预算降到100，保留第一个点，重新规划',
    ],
  };
}

export async function listTravelPois(query: { area?: string | null; route_mode?: RouteMode; limit?: number }) {
  const data = await loadTravelData();
  const request = normalizeRequest({ route_mode: query.route_mode || 'mixed', area: query.area || null });
  const items = candidatePool(data, request)
    .filter((item) => !query.area || item.area === query.area || item.district === query.area)
    .slice(0, Math.min(Number(query.limit || 100), 500));
  return { items, count: items.length, data_root: DATA_ROOT };
}

export async function getTravelEvidence(poiId: string) {
  const data = await loadTravelData();
  const poi = [...data.plannerEntities, ...data.mixedPois, ...data.culturePois].find((item) => item.poi_id === poiId);
  return {
    poi,
    evidence_summary: poi ? buildStopEvidence(poi, data) : null,
    claims: data.reviewAggregates.filter((item) => item.poi_id === poiId),
  };
}

export async function parseGoalToTravelRequest(goal: string, defaults?: Partial<TravelPlanningRequest>) {
  const parsed = parseGoal(goal, defaults || {});
  return {
    parsed_request: parsed,
    parser_confidence: goal.trim() ? 0.86 : 0.2,
    parser_notes: ['Local rules parsed area, budget, duration, meal, queue, and walking preferences.'],
    parser_correction_hints: goal.trim() ? [] : ['Please describe area, duration, budget, or preference.'],
  };
}

export async function planTravelRoute(payload: Partial<TravelPlanningRequest>) {
  const started = performance.now();
  const data = await loadTravelData();
  const request = normalizeRequest(payload);
  const pool = candidatePool(data, request);
  const selectedArea = selectArea(request, pool);
  const proposals = (['balanced', 'budget', 'efficient'] as Strategy[]).map((strategy) => buildProposal({ request, strategy, selectedArea, candidates: pool, data }));
  const dayCount = Math.max(1, Math.min(5, Number(request.day_count || 1)));
  const dayAreas = request.area ? [selectedArea] : selectPopularAreas(pool, dayCount);
  const dailyItinerary = Array.from({ length: dayCount }, (_, index) => {
    const dayArea = dayAreas[index % dayAreas.length] || selectedArea;
    const dayRequest = normalizeRequest({
      ...request,
      area: dayArea,
      max_total_pois: request.max_duration_min && request.max_duration_min >= 420 ? 4 : request.max_total_pois,
      exclude_poi_ids: [...(request.exclude_poi_ids || []), ...proposals[0].ordered_poi_ids.slice(0, index * 2)],
    });
    const dayProposal = buildProposal({ request: dayRequest, strategy: index % 3 === 0 ? 'balanced' : index % 3 === 1 ? 'efficient' : 'budget', selectedArea: dayArea, candidates: pool, data });
    return { day: index + 1, title: `Day ${index + 1}`, area: dayArea, theme: index === 0 ? 'Classic area' : index === 1 ? 'Food and culture mix' : 'Budget-friendly culture', proposal: dayProposal };
  });
  return {
    request_id: `travel-${Math.random().toString(16).slice(2, 12)}`,
    city_id: 'beijing',
    route_mode: request.route_mode,
    goal: request.goal,
    resolved_area: selectedArea,
    persona_id: request.persona_id,
    evidence_summary: {
      data_root: DATA_ROOT,
      poi_count: data.plannerEntities.length,
      review_feature_count: data.reviewAggregates.length,
      static_data_notice: 'UGC and opening hours come from local static data, not realtime queue or realtime operations.',
    },
    request_snapshot: request,
    day_count: dayCount,
    daily_itinerary: dailyItinerary,
    proposals,
    generation_metrics: { elapsed_ms: Number((performance.now() - started).toFixed(2)), within_10s: performance.now() - started < 10000 },
    replan_metadata: null,
  };
}

export async function parseAndPlanTravel(payload: { goal?: string; defaults?: Partial<TravelPlanningRequest> }) {
  const parsed = await parseGoalToTravelRequest(String(payload.goal || ''), payload.defaults);
  const planning_response = await planTravelRoute(parsed.parsed_request);
  return { ...parsed, planning_response };
}

export async function replanTravelRoute(payload: {
  previous_request?: Partial<TravelPlanningRequest>;
  selected_proposal?: { ordered_poi_ids?: string[]; ordered_poi_names?: string[] };
  adjustment_text?: string;
  locked_poi_ids?: string[];
}) {
  const data = await loadTravelData();
  const previous = normalizeRequest(payload.previous_request || {});
  const parsed = parseGoal(payload.adjustment_text || '', previous);
  const locked = [...(payload.locked_poi_ids || [])];
  const selectedFirst = payload.selected_proposal?.ordered_poi_ids?.[0];
  const adjustmentText = payload.adjustment_text || '';
  if (selectedFirst && /保留|锁定|不要删/.test(adjustmentText)) locked.push(selectedFirst);
  const selectedIds = payload.selected_proposal?.ordered_poi_ids || [];
  const targetedReplacementIndex = parseTargetedReplacementIndex(adjustmentText, selectedIds.length);
  const targetedReplacementId = targetedReplacementIndex === null ? null : selectedIds[targetedReplacementIndex];
  const selectedPois = selectedIds
    .map((id) => data.plannerEntities.find((item) => item.poi_id === id) || data.culturePois.find((item) => item.poi_id === id) || data.mixedPois.find((item) => item.poi_id === id))
    .filter(Boolean) as Poi[];
  const excludedNames = (parsed.exclude_names || []).map(normalizePoiName);
  const excludedIds = new Set(parsed.exclude_poi_ids || []);
  if (targetedReplacementId) excludedIds.add(targetedReplacementId);
  for (const poi of selectedPois) {
    if (matchesExcludedName(poi, excludedNames)) {
      excludedIds.add(poi.poi_id);
    }
  }
  if (adjustmentWantsFoodChange(adjustmentText)) {
    for (const poi of selectedPois.filter(isFoodPoi)) excludedIds.add(poi.poi_id);
  }
  const selectedFoodIds = new Set(selectedPois.filter(isFoodPoi).map((poi) => poi.poi_id));
  parsed.must_include_poi_ids = (parsed.must_include_poi_ids || []).filter((id) => {
    if (excludedIds.has(id)) return false;
    return !(adjustmentWantsFoodChange(adjustmentText) && selectedFoodIds.has(id));
  });
  for (const poi of selectedPois) {
    if (shouldPreservePoiOnReplan({ poi, adjustmentText, excludedNames, excludedIds })) locked.push(poi.poi_id);
  }
  parsed.exclude_poi_ids = Array.from(new Set([...(parsed.exclude_poi_ids || []), ...excludedIds]));
  if (adjustmentWantsSnack(adjustmentText)) {
    parsed.preference_signals = { ...(parsed.preference_signals || {}), lunch: true, coffee: false };
  }
  parsed.must_include_poi_ids = Array.from(new Set([...(parsed.must_include_poi_ids || []), ...locked]))
    .filter((id) => !excludedIds.has(id));
  let result = await planTravelRoute(parsed);
  const leakedNames = result.proposals
    .flatMap((proposal) => proposal.pois || [])
    .filter((poi: Pick<Poi, 'poi_id' | 'name'>) => excludedIds.has(poi.poi_id) || matchesExcludedName(poi, parsed.exclude_names || []))
    .map((poi: Pick<Poi, 'name'>) => poi.name);
  if (leakedNames.length > 0) {
    parsed.must_include_poi_ids = (parsed.must_include_poi_ids || []).filter((id) => !excludedIds.has(id));
    result = await planTravelRoute(parsed);
  }
  return {
    ...result,
    replan_metadata: {
      source_request_applied: Boolean(payload.previous_request),
      adjustment_text: payload.adjustment_text || '',
      locked_poi_ids: parsed.must_include_poi_ids,
      applied_adjustments: [
        parsed.max_budget !== previous.max_budget ? 'Budget constraint updated.' : null,
        parsed.walk_preference !== previous.walk_preference ? 'Walking preference updated.' : null,
        parsed.max_duration_min !== previous.max_duration_min ? 'Duration constraint updated.' : null,
        targetedReplacementId ? `Targeted replacement applied for stop ${Number(targetedReplacementIndex) + 1}.` : null,
        parsed.must_include_poi_ids?.length ? 'Unchanged POIs preserved for local replan.' : null,
        adjustmentWantsFoodChange(adjustmentText) ? 'Food stop replacement applied without rebuilding the full route.' : null,
        leakedNames.length ? 'Excluded POI leak prevented by final guard.' : null,
      ].filter(Boolean),
    },
  };
}
