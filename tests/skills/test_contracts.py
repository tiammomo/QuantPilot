"""Offline executable contracts for every governed skill helper (no provider/LLM claims)."""
from copy import deepcopy
from datetime import date, timedelta
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / '.pi' / 'skills'
CASES = []


def case(name, script, payload, expected=None, *, invalid=False, args=None):
    CASES.append((name, script, payload, expected or {}, invalid, args or []))


def changed(value, **fields):
    return {**deepcopy(value), **fields}


def bars(count=65):
    return [{'date': (date(2026, 1, 1) + timedelta(days=i)).isoformat(),
             'open': 100 + i, 'high': 102 + i, 'low': 99 + i, 'close': 101 + i,
             'volume': 1000, 'amount': 1_000_000} for i in range(count)]


rewrite = dict(schemaVersion=4, originalQuery='测试证券走势', normalizedQuery='测试证券走势',
               rewrittenQuery='分析测试证券走势', capabilityHint='technical_analysis',
               status='ready', confidence=0.9, outputIntent='dashboard', broadUniverse=False,
               safety=dict(decision='allow', code=None, message=None),
               execution=dict(strategy='llm_primary', llm=dict(attempted=True, applied=True,
                   status='applied', provider='fixture', model='fixture', semanticConfidence=0.9)),
               targetCandidates=['测试证券'], resolvedSymbols=[dict(symbol='600001', name='测试证券', query='测试证券')],
               unresolvedTargets=[], ambiguousTargets=[], issues=[])
plan = dict(schemaVersion=1, runId='fixture-run', status='planned', capabilityId='technical_analysis',
            question='测试证券走势', symbols=['600001'], dataRequirements=['bars'], analysisSteps=['trend'],
            expectedArtifacts=['dashboard-data'], validationRules=['evidence'],
            visualization=dict(required=True, panels=['trend']))
case('planner_ready', 'run-planner/intent_clarifier', dict(runPlan=plan, queryRewrite=rewrite), {'executable': True})
case('planner_mismatched_symbols', 'run-planner/intent_clarifier',
     dict(runPlan=changed(plan, symbols=['600002']), queryRewrite=rewrite), invalid=True)
case('planner_no_keyword_fallback', 'run-planner/intent_clarifier', {'question': '贵州茅台走势'}, invalid=True)
clarify = changed(plan, status='needs_clarification', symbols=[], clarification=dict(required=True, questions=['研究哪个标的？']))
case('planner_stops_for_clarification', 'run-planner/intent_clarifier',
     dict(runPlan=clarify, queryRewrite=changed(rewrite, status='needs_clarification', resolvedSymbols=[])), {'executable': False, 'questions.0': '研究哪个标的？'})
case('rewrite_ready', 'query-rewrite/validate_query_rewrite', rewrite, {'valid': True})
case('rewrite_ambiguous_ready', 'query-rewrite/validate_query_rewrite', changed(rewrite, ambiguousTargets=[{'query': '银行'}]), invalid=True)
unavailable = changed(rewrite, execution=dict(strategy='llm_unavailable', llm=dict(attempted=True, applied=False, status='failed')))
case('rewrite_no_unavailable_success', 'query-rewrite/validate_query_rewrite', unavailable, invalid=True)
case('registry_local_first', 'quant-data-registry/select_data_route',
     dict(operation='historical_bars', symbol='600001', local_coverage=dict(available=True, covers_range=True)), {'decision': 'local_historical_bars'})
case('registry_missing_provider', 'quant-data-registry/select_data_route',
     dict(operation='historical_bars', symbol='600001'), {'decision': 'unavailable', 'endpoint': None})
case('registry_reject_path', 'quant-data-registry/select_data_route', dict(operation='universe_members', universe_id='../escape'), invalid=True)
candidates = [dict(symbol='600001', name='测试证券', market='SH', asset_type='stock')]
case('resolver_exact', 'quant-symbol-resolver/rank_candidates', dict(query='测试证券', candidates=candidates), {'status': 'resolved', 'selected.symbol': '600001'})
case('resolver_tie', 'quant-symbol-resolver/rank_candidates', dict(query='测试证券', candidates=candidates + [dict(symbol='600002', name='测试证券', market='SH')]), {'status': 'ambiguous', 'selected': None})
case('resolver_never_promotes_fuzzy', 'quant-symbol-resolver/rank_candidates', dict(query='测试', candidates=candidates), {'status': 'ambiguous', 'selected': None})
image = dict(images=[dict(path='uploads/account.png', sha256='a' * 64)], extractedFields=dict(total_assets='1.2万', holdings=[]))
case('image_partial', 'image-extraction/normalize_extraction', image, {'status': 'needs_manual_confirmation', 'imageExtraction.source': 'uploaded_image'})
case('image_missing_hash', 'image-extraction/normalize_extraction', changed(image, images=[dict(path='uploads/a.png')]), invalid=True)
case('image_escape', 'image-extraction/normalize_extraction', changed(image, images=[dict(path='../account.png', sha256='a' * 64)]), invalid=True)
market = dict(symbol='600001', timeframe='1d', adjustment='qfq', source='fixture', bars=bars(3), as_of='2026-01-04')
case('market_valid', 'quant-market-data/validate_market_bars', market, {'ok': True})
case('market_future', 'quant-market-data/validate_market_bars', changed(market, as_of='2026-01-01'), invalid=True)
case('market_upstream_failed', 'quant-market-data/validate_market_bars', changed(market, data_quality={'status': 'error'}), invalid=True)
case('market_bad_ohlc', 'quant-market-data/validate_market_bars', changed(market, bars=[changed(bars(1)[0], high=1)]), invalid=True)
case('market_duplicate', 'quant-market-data/validate_market_bars', changed(market, bars=[bars(1)[0]] * 2), invalid=True)
valuation = dict(symbol='600001', quote=dict(price=20, pe_ttm=10), financials=dict(summary=dict(eps_ttm=2)))
case('valuation_missing', 'quant-fundamentals/valuation_scenarios', {}, {'data_quality.status': 'warning', 'assets.0.scenarios': []})
# Asset-level summary shape follows the public helper contract.
valuation['fundamentalSummary'] = dict(eps_ttm=2)
case('valuation_scenarios', 'quant-fundamentals/valuation_scenarios', valuation, {'assets.0.base_metrics.pe_ttm': 10.0, 'assets.0.scenarios.1.implied_price': 21.0})
zero = changed(valuation, quote=dict(price=20, pe_ttm=0, pe=10))
case('valuation_zero_not_fallback', 'quant-fundamentals/valuation_scenarios', zero, {'assets.0.base_metrics.pe_ttm': 0.0, 'assets.0.scenarios': []})
assets = [dict(symbol='600001', bars=bars(6)), dict(symbol='600002', bars=bars(6))]
case('correlation_aligned', 'quant-indicators/correlation', dict(assets=assets), {'top_pairs.0.correlation': 1.0, 'top_pairs.0.overlap': 5})
# Same end date but different preceding observations must never be paired.
gapped = [dict(symbol='600001', bars=bars(6)), dict(symbol='600002', bars=[bars(6)[i] for i in [0, 2, 4, 5]])]
case('correlation_gap_intervals', 'quant-indicators/correlation', dict(assets=gapped), {'top_pairs.0.overlap': 1, 'top_pairs.0.correlation': None, 'data_quality.status': 'warning'})
case('correlation_duplicate_asset', 'quant-indicators/correlation', dict(assets=[assets[0], assets[0]]), invalid=True)
case('indicator_valid', 'quant-indicators/validate_indicator_bars', bars(3), {'ok': True, 'row_count': 3})
case('indicator_reverse', 'quant-indicators/validate_indicator_bars', bars(3)[::-1], invalid=True)
case('indicator_nonfinite', 'quant-indicators/validate_indicator_bars', [changed(bars(1)[0], close='NaN')], invalid=True)
case('liquidity_zero_observed', 'quant-indicators/liquidity', dict(symbol='600001', bars=bars(), quote=dict(amount=0, market_cap=1e9)), {'rows.0.latest_amount': 0.0, 'rows.0.turnover_proxy_pct': 0.0})
case('liquidity_missing_amount', 'quant-indicators/liquidity', dict(bars=[{k:v for k,v in bar.items() if k != 'amount'} for bar in bars()]), {'rows.0.avg_amount_20d': None, 'data_quality.status': 'warning'})
case('trend_valid', 'quant-indicators/trend_template', dict(bars=bars()), {'rows.0.metrics.ma20': 155.5, 'rows.0.metrics.volume_ratio_20d': 1.0})
missing_volume = bars(); del missing_volume[-1]['volume']
case('trend_no_compressed_window', 'quant-indicators/trend_template', dict(bars=missing_volume), {'rows.0.metrics.volume_ratio_20d': None, 'data_quality.status': 'warning'})
curve = [dict(date='2026-01-01', equity=100, drawdown=0, position=0), dict(date='2026-01-02', equity=90, drawdown=-0.1, position=1)]
backtest = dict(parameters=dict(fast_window=5, slow_window=20, fee_bps=2, adjustment='qfq', period='1d'),
                summary=dict(start='2026-01-01', end='2026-01-02', final_equity=90, strategy_return=-0.1, max_drawdown=-0.1, trade_count=0),
                equity_curve=curve, trades=[], data_quality=dict(source='fixture', limitations=['no slippage']))
case('backtest_valid', 'quant-backtest/validate_backtest', backtest, {'ok': True})
case('backtest_false_drawdown', 'quant-backtest/validate_backtest', changed(backtest, equity_curve=[curve[0], changed(curve[1], drawdown=0)], summary=changed(backtest['summary'], max_drawdown=0)), invalid=True)
case('backtest_reverse_windows', 'quant-backtest/validate_backtest', changed(backtest, parameters=changed(backtest['parameters'], fast_window=30)), invalid=True)
dataset = dict(dataset='bars', row_count=3, source='fixture', fetched_at='2026-01-04T00:00:00Z', as_of='2026-01-03T00:00:00Z', artifact_path='data_file/raw/bars.json', required_fields=['close'], available_fields=['close'])
case('quality_valid', 'data-quality/assess_data_quality', dict(datasets=[dataset]), {'data_quality.status': 'ok'})
case('quality_missing_critical', 'data-quality/assess_data_quality', dict(datasets=[changed(dataset, critical_fields=['amount'])]), {'data_quality.status': 'error'})
case('quality_no_fake_time', 'data-quality/assess_data_quality', dict(datasets=[changed(dataset, fetched_at=None)]), {'data_quality.status': 'warning', 'sources.sources.0.fetched_at': None})
case('quality_secret', 'data-quality/assess_data_quality', dict(datasets=[dataset], api_key='fixture'), invalid=True)
case('quality_invalid_date', 'data-quality/assess_data_quality', dict(datasets=[changed(dataset, fetched_at='yesterday')]), invalid=True)
ui = dict(page='Skills Market', primary_action='inspect', viewports=[375, 768, 1440],
          states={state: True for state in ['loading', 'empty', 'error', 'disabled', 'pending', 'long_text']},
          accessibility={key: True for key in ['keyboard_focus', 'icon_labels', 'semantic_headings', 'color_independent_status']}, evidence=['browser fixture'])
case('ui_matrix', 'platform-ui-product-design/validate_state_matrix', ui, {'ok': True})
case('ui_missing_mobile', 'platform-ui-product-design/validate_state_matrix', changed(ui, viewports=[1440]), invalid=True)
case('ui_unevidenced_state', 'platform-ui-product-design/validate_state_matrix', changed(ui, states=changed(ui['states'], error=False)), invalid=True)
dashboard = dict(quote=dict(symbol='600001', price=20), visualization=dict(template_id='technical-timing', required_components=['chart'], rendered_components=['chart'], missing_components=[]))
case('dashboard_valid', 'dashboard-visualization/validate_dashboard_contract', dashboard, {'ok': True}, args=['--expected-symbol', '600001'])
case('dashboard_missing_symbol', 'dashboard-visualization/validate_dashboard_contract', dashboard, invalid=True, args=['--expected-symbol', '600002'])
case('dashboard_inconsistent_component', 'dashboard-visualization/validate_dashboard_contract', changed(dashboard, visualization=changed(dashboard['visualization'], missing_components=['chart'])), invalid=True)
case('dashboard_missing_contract', 'dashboard-visualization/validate_dashboard_contract', changed(dashboard, visualization={'template_id': 'technical-timing'}), invalid=True)

case('market_nullable_fields', 'quant-market-data/validate_market_bars', changed(market, bars=[changed(bars(1)[0], amount=None, turnover=None)]), {'ok': True})
case('market_exchange_date', 'quant-market-data/validate_market_bars', changed(market, timezone='Asia/Shanghai', as_of='2026-01-02T17:00:00Z'), {'ok': True})
case('market_future_exchange_date', 'quant-market-data/validate_market_bars', changed(market, timezone='Asia/Shanghai', as_of='2026-01-01T17:00:00Z'), invalid=True)
api_backtest = dict(source='fixture', parameters={}, fast_window=5, slow_window=20, fee_bps='2', period='daily', adjustment='qfq',
    summary=dict(start_date='2026-01-01', end_date='2026-01-02', initial_cash='100', final_equity='90', total_return_pct='-10', max_drawdown_pct='-10', trade_count=0),
    equity_curve=[dict(date='2026-01-01', equity='100', drawdown_pct='0', position=0), dict(date='2026-01-02', equity='90', drawdown_pct='-10', position=1)],
    trades=[dict(entry_date='2026-01-02', entry_price='10', status='open')], data_quality=dict(status='ok'))
case('backtest_api_percentage_units', 'quant-backtest/validate_backtest', api_backtest, {'ok': True, 'stats.trade_count': 0})
case('backtest_api_false_closed_count', 'quant-backtest/validate_backtest', changed(api_backtest, summary=changed(api_backtest['summary'], trade_count=1)), invalid=True)
case('backtest_api_parameter_conflict', 'quant-backtest/validate_backtest', changed(api_backtest, parameters={'fast_window': 3}), invalid=True)

case('correlation_rejects_mixed_adjustment', 'quant-indicators/correlation', dict(assets=[changed(assets[0], adjustment='qfq'), changed(assets[1], adjustment='hfq')]), invalid=True)
case('correlation_rejects_mixed_period', 'quant-indicators/correlation', dict(assets=[changed(assets[0], period='daily'), changed(assets[1], period='weekly')]), invalid=True)


class SkillContracts(unittest.TestCase):
    def run_case(self, script, payload, expected, invalid, args):
        skill, helper = script.split('/')
        file = SCRIPTS / skill / 'scripts' / (helper + '.py')
        positional = helper in {'valuation_scenarios', 'correlation', 'liquidity', 'trend_template'}
        command = [sys.executable, str(file), *(['-'] if positional else ['--input', '-']), *args]
        result = subprocess.run(command, input=json.dumps(payload), capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode != 0, invalid, result.stdout + result.stderr)
        self.assertNotIn('Traceback', result.stderr)
        if not invalid:
            value = json.loads(result.stdout)
            for pointer, want in expected.items():
                actual = value
                for part in pointer.split('.'):
                    actual = actual[int(part)] if isinstance(actual, list) else actual[part]
                self.assertEqual(actual, want, pointer)

    def test_every_script_has_behavior_coverage(self):
        files = {f'{p.parts[-3]}/{p.stem}' for p in SCRIPTS.glob('*/scripts/*.py')}
        self.assertEqual(files, {row[1] for row in CASES})
        self.assertEqual(len({row[1].split('/')[0] for row in CASES}), 12)


def add_test(name, script, payload, expected, invalid, args):
    def test(self):
        self.run_case(script, payload, expected, invalid, args)
    setattr(SkillContracts, 'test_' + name, test)


for row in CASES:
    add_test(*row)
for script in sorted({row[1] for row in CASES}):
    add_test('invalid_root_' + script.replace('/', '_'), script, None, {}, True, [])

if __name__ == '__main__':
    unittest.main(verbosity=2)
