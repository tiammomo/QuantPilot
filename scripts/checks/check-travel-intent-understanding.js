const baseUrl = process.env.TRAVELPILOT_TEST_BASE_URL || 'http://localhost:3000';

async function post(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} failed: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(array, value, message) {
  assert(Array.isArray(array) && array.includes(value), message);
}

const cases = [
  {
    name: 'common_qianmen_full_constraints',
    text: '前门附近玩4小时，中午吃饭，预算200以内，少走路，不想排队。',
    expect: {
      area: '前门',
      duration_minutes: 240,
      budget_cny: 200,
      needs_meal: true,
      meal_type: 'meal',
      avoid_queue: true,
      walk_preference: 'low',
      route_mode: 'mixed',
      missing_fields: [],
    },
  },
  {
    name: 'culture_no_meal',
    text: '故宫附近文化路线，不吃饭，预算100以内，少走路。',
    expect: {
      area: '故宫',
      budget_cny: 100,
      needs_meal: false,
      meal_type: null,
      walk_preference: 'low',
      route_mode: 'culture',
    },
  },
  {
    name: 'senior_relaxed',
    text: '带老人去北海，别太累，玩3小时，中午吃饭。',
    expect: {
      area: '北海',
      duration_minutes: 180,
      persona: 'senior',
      walk_preference: 'low',
      needs_meal: true,
    },
  },
  {
    name: 'couple_romantic',
    text: '情侣在王府井晚上玩3小时，吃饭，想浪漫一点，不想排队。',
    expect: {
      area: '王府井',
      duration_minutes: 180,
      persona: 'couple',
      needs_meal: true,
      avoid_queue: true,
    },
  },
  {
    name: 'family_indoor',
    text: '亲子半日游，室内优先，中午吃饭，预算300以内。',
    expect: {
      duration_minutes: 240,
      budget_cny: 300,
      persona: 'family',
      indoor_preferred: true,
      needs_meal: true,
      missing_includes: ['area'],
    },
  },
  {
    name: 'replan_replace_indoor',
    text: '把第二个点换成室内点，其他地方不变。',
    expect: {
      replan_action: 'replace_stop',
      indoor_preferred: true,
      missing_includes: ['area', 'duration_minutes'],
    },
  },
  {
    name: 'replan_add_lunch',
    text: '再加一个顺路的午餐地点，原来的点都保留。',
    expect: {
      replan_action: 'add_stop',
      needs_meal: true,
      missing_includes: ['area', 'duration_minutes'],
    },
  },
  {
    name: 'ambiguous_clarification',
    text: '想轻松逛逛，别太商业，顺便吃点东西。',
    expect: {
      walk_preference: 'low',
      missing_includes: ['area', 'duration_minutes'],
    },
    allowMinimaxMealInference: true,
  },
];

function assertIntent(name, intent, expect) {
  for (const [key, value] of Object.entries(expect)) {
    if (key === 'missing_includes') {
      for (const item of value) assertIncludes(intent.missing_fields, item, `${name}: missing_fields should include ${item}`);
      continue;
    }
    if (key === 'missing_fields') {
      assert(JSON.stringify(intent.missing_fields || []) === JSON.stringify(value), `${name}: expected missing_fields=${JSON.stringify(value)}, got ${JSON.stringify(intent.missing_fields)}`);
      continue;
    }
    assert(intent[key] === value, `${name}: expected ${key}=${JSON.stringify(value)}, got ${JSON.stringify(intent[key])}`);
  }
}

async function main() {
  const rows = [];
  for (const item of cases) {
    const result = await post('/api/v1/travel/query-plan', {
      raw_text: item.text,
      dry_run: true,
    });
    const intent = result.intent;
    assert(intent && typeof intent === 'object', `${item.name}: intent should exist`);
    assert(['dictionary', 'minimax', 'cache'].includes(String(intent.parser)), `${item.name}: unexpected parser ${intent.parser}`);
    assert(Number(intent.confidence) >= 0 && Number(intent.confidence) <= 1, `${item.name}: confidence should be 0..1`);
    if (item.allowMinimaxMealInference) {
      assert(
        intent.parser === 'minimax' || intent.llm_attempted === true || intent.notes?.some((note) => String(note).includes('MiniMax')),
        `${item.name}: ambiguous expression should involve MiniMax attempt instead of pure rule-only parsing`,
      );
    }
    assertIntent(item.name, intent, item.expect);
    rows.push({
      case: item.name,
      parser: intent.parser,
      llm_used: intent.llm_used,
      llm_attempted: intent.llm_attempted,
      cache_hit: intent.cache_hit,
      confidence: intent.confidence,
      missing_fields: intent.missing_fields,
      area: intent.area,
      duration_minutes: intent.duration_minutes,
      persona: intent.persona,
      replan_action: intent.replan_action,
    });
  }

  const repeated = await post('/api/v1/travel/query-plan', {
    raw_text: cases[0].text,
    dry_run: true,
  });
  assert(repeated.intent?.parser === 'cache', `repeat request should hit cache, got ${repeated.intent?.parser}`);
  rows.push({
    case: 'repeat_cache_hit',
    parser: repeated.intent.parser,
    llm_used: repeated.intent.llm_used,
    llm_attempted: repeated.intent.llm_attempted,
    cache_hit: repeated.intent.cache_hit,
    confidence: repeated.intent.confidence,
    missing_fields: repeated.intent.missing_fields,
  });

  console.log('[travel-intent-understanding] passed');
  console.table(rows);
}

main().catch((error) => {
  console.error('[travel-intent-understanding] failed:', error);
  process.exit(1);
});
