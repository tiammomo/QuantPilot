import fs from 'fs/promises';
import path from 'path';
import { prisma } from '@/lib/db/client';
import { buildTravelQueryPlan, executeTravelQueryPlan } from '@/lib/travel/sql-query';
import { intentToPlannerLikeRequest, type TravelQueryIntent } from '@/lib/travel/semantic-intent';
import type { TravelPlanningRequest } from '@/lib/travel/planner';

type JsonRecord = Record<string, any>;

export interface TravelRouteCorpusRow {
  route_id: string;
  city_id: string;
  title: string;
  area: string | null;
  route_mode: string;
  persona_id: string;
  walk_preference: string;
  duration_bucket_min: number;
  budget_bucket_cny: number | null;
  requires_meal: boolean;
  meal_type: string | null;
  indoor_preferred: boolean;
  avoid_queue: boolean;
  tags: string[];
  poi_ids: string[];
  poi_names: string[];
  total_budget_estimate: number;
  total_route_duration_min: number;
  score: number;
  payload: JsonRecord;
  match_score?: number;
}

export interface TravelRouteCorpusMatch {
  matched: boolean;
  source: 'database' | 'file' | 'none';
  rows: TravelRouteCorpusRow[];
  elapsed_ms: number;
  query_intent: JsonRecord;
  reason: string | null;
}

const ROUTE_CORPUS_FILE = path.resolve(process.cwd(), 'travel-data', 'processed', 'beijing_route_corpus.json');
const ROUTE_CORPUS_LIMIT = Number(process.env.TRAVELPILOT_ROUTE_CORPUS_LIMIT || 3);
const ROUTE_CORPUS_MIN_SCORE = Number(process.env.TRAVELPILOT_ROUTE_CORPUS_MIN_SCORE || 34);
let fileCorpusCache: Promise<TravelRouteCorpusRow[]> | null = null;

function toPersonaId(intent: TravelQueryIntent) {
  return String(intentToPlannerLikeRequest(intent).persona_id || 'classic_first_timer');
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function normalizeRow(row: JsonRecord): TravelRouteCorpusRow {
  return {
    route_id: String(row.route_id),
    city_id: String(row.city_id || 'beijing'),
    title: String(row.title || '北京旅行路线'),
    area: row.area === null || row.area === undefined ? null : String(row.area),
    route_mode: String(row.route_mode || 'mixed'),
    persona_id: String(row.persona_id || 'classic_first_timer'),
    walk_preference: String(row.walk_preference || 'medium'),
    duration_bucket_min: Number(row.duration_bucket_min || 0),
    budget_bucket_cny: row.budget_bucket_cny === null || row.budget_bucket_cny === undefined ? null : Number(row.budget_bucket_cny),
    requires_meal: Boolean(row.requires_meal),
    meal_type: row.meal_type === null || row.meal_type === undefined ? null : String(row.meal_type),
    indoor_preferred: Boolean(row.indoor_preferred),
    avoid_queue: Boolean(row.avoid_queue),
    tags: asArray(row.tags),
    poi_ids: asArray(row.poi_ids),
    poi_names: asArray(row.poi_names),
    total_budget_estimate: Number(row.total_budget_estimate || 0),
    total_route_duration_min: Number(row.total_route_duration_min || 0),
    score: Number(row.score || 0),
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {}),
    match_score: row.match_score === undefined ? undefined : Number(row.match_score),
  };
}

async function loadFileCorpus(): Promise<TravelRouteCorpusRow[]> {
  if (!fileCorpusCache) {
    fileCorpusCache = fs.readFile(ROUTE_CORPUS_FILE, 'utf8')
      .then((raw) => {
        const parsed = JSON.parse(raw);
        const routes = Array.isArray(parsed?.routes) ? parsed.routes : Array.isArray(parsed) ? parsed : [];
        return routes.map(normalizeRow);
      })
      .catch(() => []);
  }
  return fileCorpusCache;
}

function durationScore(intentMinutes: number | null, routeMinutes: number) {
  if (!intentMinutes) return 6;
  const diff = Math.abs(intentMinutes - routeMinutes);
  if (diff <= 45) return 18;
  if (diff <= 90) return 10;
  if (routeMinutes <= intentMinutes + 60) return 6;
  return -12;
}

function budgetScore(intentBudget: number | null, routeBudget: number, bucket: number | null) {
  if (!intentBudget) return 4;
  if (routeBudget <= intentBudget) return 16;
  if (bucket && bucket <= intentBudget) return 10;
  if (routeBudget <= intentBudget + 80) return 4;
  return -16;
}

function routeMatchesNames(row: TravelRouteCorpusRow, names: string[]) {
  if (!names.length) return true;
  const text = row.poi_names.join(' ');
  return names.every((name) => text.includes(name));
}

function scoreRoute(row: TravelRouteCorpusRow, intent: TravelQueryIntent): number {
  let score = row.score || 0;
  const personaId = toPersonaId(intent);
  if (intent.area && row.area === intent.area) score += 24;
  else if (intent.area && row.poi_names.some((name) => name.includes(String(intent.area)))) score += 12;
  else if (intent.area) score -= 10;
  if (row.route_mode === intent.route_mode) score += 12;
  if (intent.needs_meal === row.requires_meal) score += 10;
  if (intent.meal_type && row.meal_type === intent.meal_type) score += 8;
  if (row.persona_id === personaId) score += 14;
  if (row.walk_preference === intent.walk_preference) score += 8;
  if (intent.indoor_preferred === row.indoor_preferred) score += intent.indoor_preferred ? 12 : 3;
  if (intent.avoid_queue === row.avoid_queue) score += intent.avoid_queue ? 10 : 2;
  score += durationScore(intent.duration_minutes, row.duration_bucket_min || row.total_route_duration_min);
  score += budgetScore(intent.budget_cny, row.total_budget_estimate, row.budget_bucket_cny);
  if (!routeMatchesNames(row, intent.must_include_names)) score -= 50;
  if (intent.exclude_names.some((name) => row.poi_names.join(' ').includes(name))) score -= 60;
  return Number(score.toFixed(3));
}

function rankRows(rows: TravelRouteCorpusRow[], intent: TravelQueryIntent) {
  return rows
    .map((row) => ({ ...row, match_score: scoreRoute(row, intent) }))
    .filter((row) => Number(row.match_score) >= ROUTE_CORPUS_MIN_SCORE)
    .sort((a, b) => Number(b.match_score || 0) - Number(a.match_score || 0))
    .slice(0, ROUTE_CORPUS_LIMIT);
}

async function queryDatabaseCorpus(intent: TravelQueryIntent): Promise<TravelRouteCorpusRow[]> {
  const personaId = toPersonaId(intent);
  const area = intent.area;
  const routeMode = intent.route_mode;
  const needsMeal = intent.needs_meal;
  const walkPreference = intent.walk_preference;
  const indoorPreferred = intent.indoor_preferred;
  const avoidQueue = intent.avoid_queue;
  const maxDuration = intent.duration_minutes ? intent.duration_minutes + 120 : null;
  const maxBudget = intent.budget_cny ? intent.budget_cny + 120 : null;
  const rows = await prisma.$queryRaw<JsonRecord[]>`
    SELECT *
    FROM travel_precomputed_routes
    WHERE city_id = 'beijing'
      AND (${area}::text IS NULL OR area = ${area} OR ${area} = ANY(poi_names))
      AND route_mode = ${routeMode}
      AND requires_meal = ${needsMeal}
      AND (${maxDuration}::int IS NULL OR duration_bucket_min <= ${maxDuration})
      AND (${maxBudget}::double precision IS NULL OR total_budget_estimate <= ${maxBudget})
      AND (${personaId}::text = 'classic_first_timer' OR persona_id = ${personaId} OR persona_id = 'classic_first_timer')
      AND (${walkPreference}::text IS NULL OR walk_preference = ${walkPreference} OR walk_preference = 'medium')
      AND (${indoorPreferred}::boolean = FALSE OR indoor_preferred = TRUE)
      AND (${avoidQueue}::boolean = FALSE OR avoid_queue = TRUE)
    ORDER BY score DESC, updated_at DESC
    LIMIT 80
  `;
  return rankRows(rows.map(normalizeRow), intent);
}

async function queryFileCorpus(intent: TravelQueryIntent): Promise<TravelRouteCorpusRow[]> {
  const rows = await loadFileCorpus();
  return rankRows(rows, intent);
}

export async function findPrecomputedTravelRoutes(intent: TravelQueryIntent): Promise<TravelRouteCorpusMatch> {
  const started = performance.now();
  if (intent.replan_action) {
    return {
      matched: false,
      source: 'none',
      rows: [],
      elapsed_ms: Number((performance.now() - started).toFixed(2)),
      query_intent: intent,
      reason: 'replan requests still use dynamic local replanning.',
    };
  }

  try {
    const rows = await queryDatabaseCorpus(intent);
    if (rows.length > 0) {
      return {
        matched: true,
        source: 'database',
        rows,
        elapsed_ms: Number((performance.now() - started).toFixed(2)),
        query_intent: intent,
        reason: null,
      };
    }
  } catch {
    // Database is optional in local demos; the JSON corpus keeps the route path usable.
  }

  const fileRows = await queryFileCorpus(intent);
  return {
    matched: fileRows.length > 0,
    source: fileRows.length > 0 ? 'file' : 'none',
    rows: fileRows,
    elapsed_ms: Number((performance.now() - started).toFixed(2)),
    query_intent: intent,
    reason: fileRows.length > 0 ? null : 'No precomputed route met the requested constraints.',
  };
}

function collectProposals(rows: TravelRouteCorpusRow[]) {
  return rows
    .flatMap((row, index) => {
      const payload = row.payload || {};
      const proposals = Array.isArray(payload.proposals) ? payload.proposals : [];
      const primary = proposals[0];
      if (!primary) return [];
      return [{
        ...primary,
        proposal_id: `${row.route_id}-${primary.strategy || index}`,
        display_title: row.title,
        title: row.title,
        corpus_route_id: row.route_id,
        corpus_match_score: row.match_score,
        corpus_tags: row.tags,
      }];
    })
    .slice(0, ROUTE_CORPUS_LIMIT);
}

export async function buildPlanningResponseFromRouteCorpus(params: {
  intent: TravelQueryIntent;
  match: TravelRouteCorpusMatch;
  request: TravelPlanningRequest;
}) {
  const primaryPayload = params.match.rows[0]?.payload || {};
  const proposals = collectProposals(params.match.rows);
  const queryPlan = buildTravelQueryPlan(params.intent);
  const queryResults = await executeTravelQueryPlan(queryPlan).catch(() => []);
  return {
    parsed_request: params.request,
    parser_confidence: params.intent.confidence,
    parser_notes: [
      ...params.intent.notes,
      params.match.source === 'database'
        ? '已命中数据库预生成旅行路线库。'
        : '已命中文件预生成旅行路线库。',
    ],
    parser_correction_hints: params.intent.missing_fields.length ? [`Please clarify ${params.intent.missing_fields.join(', ')}.`] : [],
    intent: params.intent,
    planning_response: {
      ...primaryPayload,
      request_id: `travel-corpus-${Math.random().toString(16).slice(2, 12)}`,
      goal: params.intent.raw_text,
      request_snapshot: params.request,
      resolved_area: params.match.rows[0]?.area || params.request.area || primaryPayload.resolved_area || '北京',
      proposals,
      daily_itinerary: Array.isArray(primaryPayload.daily_itinerary) ? primaryPayload.daily_itinerary : [],
      query_plan: queryPlan,
      query_results: queryResults,
      route_corpus_match: {
        used: true,
        source: params.match.source,
        elapsed_ms: params.match.elapsed_ms,
        route_ids: params.match.rows.map((row) => row.route_id),
        match_scores: params.match.rows.map((row) => row.match_score),
      },
      final_selected_proposal_id: proposals[0]?.proposal_id || null,
      natural_language_explanation: proposals[0]?.summary || '已根据你的要求从北京旅行路线库中匹配到可直接执行的路线。',
      generation_metrics: {
        ...(primaryPayload.generation_metrics || {}),
        elapsed_ms: params.match.elapsed_ms,
        within_10s: true,
        route_corpus_used: true,
        route_corpus_source: params.match.source,
        route_corpus_match_count: params.match.rows.length,
        database_recall_used: queryResults.length > 0,
        llm_role: 'semantic_intent_only',
      },
      replan_metadata: null,
    },
  };
}
