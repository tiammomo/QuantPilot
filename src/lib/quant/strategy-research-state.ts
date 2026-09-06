import { FALLBACK_FOUNDATION_STATE, SAMPLE_UNIVERSE_ID } from './strategy-catalog';
import type { StrategyDataCoverageItem, StrategyResearchState, StrategyFoundationState } from './strategy-types';
import {
  asRecord,
  dataStatus,
  mapResearchUniverse,
  mapFoundationComponent,
  mapFactorDefinition,
  mapTradingCalendarDay,
} from './strategy-mappers';
import { fetchMarketApiJson } from './strategy-market-api';
import { getStrategyUniverseMembersPage } from './strategy-market-client';
import { FALLBACK_RESEARCH_STATE } from './strategy-research-defaults';
export async function getStrategyResearchState(): Promise<StrategyResearchState> {
  try {
    const universesPayload = asRecord(
      await fetchMarketApiJson<unknown>('/api/v1/research/universes/summary', { timeoutMs: 2500 })
    );
    const universes = Array.isArray(universesPayload.universes)
      ? universesPayload.universes.map(mapResearchUniverse)
      : [];
    const primaryUniverse =
      universes.find((universe) => universe.id === SAMPLE_UNIVERSE_ID) ??
      universes.find((universe) => universe.stockCount > 0) ??
      universes[0] ??
      FALLBACK_RESEARCH_STATE.universes[0];
    const initialMembersPage = await getStrategyUniverseMembersPage({
      universeId: primaryUniverse.id,
      page: 1,
      pageSize: 10,
      timeoutMs: 4500,
    });
    const hydratedUniverses = universes.map((universe) =>
      universe.id === primaryUniverse.id
        ? {
            ...universe,
            members: initialMembersPage.members,
            memberCount: initialMembersPage.total || universe.memberCount,
          }
        : { ...universe, members: [] }
    );
    const coverage = initialMembersPage.members.map(
      (member): StrategyDataCoverageItem => ({
        symbol: member.symbol,
        name: member.name,
        timeframe: primaryUniverse.defaultTimeframe,
        adjustment: primaryUniverse.defaultAdjustment,
        provider: member.dataProvider ?? primaryUniverse.provider,
        firstTs: member.firstTs ?? null,
        lastTs: member.lastTs ?? null,
        rowCount: member.rowCount,
        dataStatus: member.dataStatus,
      })
    );

    return {
      ...FALLBACK_RESEARCH_STATE,
      primaryUniverseId: primaryUniverse.id,
      source: 'market-api',
      universes: hydratedUniverses.length ? hydratedUniverses : FALLBACK_RESEARCH_STATE.universes,
      coverage: coverage.length ? coverage : FALLBACK_RESEARCH_STATE.coverage,
      ingestionPlan: {
        ...FALLBACK_RESEARCH_STATE.ingestionPlan,
        universeId: primaryUniverse.id,
        timeframe: primaryUniverse.defaultTimeframe,
        adjustment: primaryUniverse.defaultAdjustment,
        provider: primaryUniverse.provider,
        lookbackYears: FALLBACK_RESEARCH_STATE.ingestionPlan.lookbackYears,
      },
      error: null,
    };
  } catch (error) {
    return {
      ...FALLBACK_RESEARCH_STATE,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getStrategyFoundationState(): Promise<StrategyFoundationState> {
  try {
    const [statusResult, factorsResult, calendarResult] = await Promise.allSettled([
      fetchMarketApiJson<unknown>('/api/v1/foundation/status', { timeoutMs: 2000 }),
      fetchMarketApiJson<unknown>('/api/v1/foundation/factors', { timeoutMs: 2000 }),
      fetchMarketApiJson<unknown>('/api/v1/foundation/trading-calendar?market=CN-A&limit=30', { timeoutMs: 2500 }),
    ]);
    const failures = [statusResult, factorsResult, calendarResult]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)));
    if (
      statusResult.status === 'rejected' &&
      factorsResult.status === 'rejected' &&
      calendarResult.status === 'rejected'
    ) {
      throw new Error(failures.join('；') || '基础组件接口暂不可用');
    }
    const statusPayload = statusResult.status === 'fulfilled' ? statusResult.value : {};
    const factorsPayload = factorsResult.status === 'fulfilled' ? factorsResult.value : {};
    const calendarPayload = calendarResult.status === 'fulfilled' ? calendarResult.value : {};
    const statusRecord = asRecord(statusPayload);
    const factorsRecord = asRecord(factorsPayload);
    const calendarRecord = asRecord(calendarPayload);
    return {
      source: 'market-api',
      components: Array.isArray(statusRecord.components)
        ? statusRecord.components.map(mapFoundationComponent)
        : FALLBACK_FOUNDATION_STATE.components,
      factors: Array.isArray(factorsRecord.factors) ? factorsRecord.factors.map(mapFactorDefinition) : [],
      calendarDays: Array.isArray(calendarRecord.days) ? calendarRecord.days.map(mapTradingCalendarDay) : [],
      latestQualityScan: null,
      error: failures.length ? failures.join('；') : null,
    };
  } catch (error) {
    return {
      ...FALLBACK_FOUNDATION_STATE,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
