import { describe, expect, it } from 'vitest';
import { assessQuantEvidence } from './evidence-quality';

const source = () => ({ id: 'quote', source: 'fixture', endpoint: 'GET /api/v1/quotes/realtime/600519', fetched_at: '2026-01-01T00:00:00Z', artifact_path: 'data_file/raw/quote.json', row_count: 1 });
describe('research evidence consistency', () => {
  it('accepts traceable evidence and returns referenced artifact paths', () => {
    expect(assessQuantEvidence({ sources: [source()] }, { status: 'ok' }))
      .toMatchObject({ passed: true, warnings: [], artifactPaths: ['data_file/raw/quote.json'] });
  });
  it.each([
    {},
    { ...source(), source: '' },
    { ...source(), artifact_path: '../outside.json' },
    { ...source(), artifact_path: '/etc/passwd' },
    { ...source(), row_count: -1 },
    { ...source(), fetched_at: 'unknown' },
  ])('rejects false or malformed source claims: %j', bad => {
    expect(assessQuantEvidence({ sources: [bad] }, { status: 'ok' }).passed).toBe(false);
  });
  it('detects duplicate sources and hidden critical errors', () => {
    expect(assessQuantEvidence({ sources: [source(), source()] }, { status: 'ok' }).passed).toBe(false);
    expect(assessQuantEvidence({ sources: [source()] }, { status: 'ok', datasets: [{ status: 'error', critical: true }] }).passed).toBe(false);
  });
  it('keeps unknown observation time and optional gaps visible', () => {
    const { fetched_at: _time, ...missingTime } = source();
    const result = assessQuantEvidence({ sources: [missingTime] }, { status: 'ok', datasets: [{ status: 'error', critical: false }] });
    expect(result.passed).toBe(true);
    expect(result.warnings).toHaveLength(2);
  });
});
