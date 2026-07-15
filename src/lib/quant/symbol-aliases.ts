export interface KnownSymbolAlias {
  keyword: string;
  symbol: string;
  name: string;
}

export interface KnownSymbolAliasMatch extends KnownSymbolAlias {
  start: number;
  end: number;
}

export const KNOWN_SYMBOL_ALIASES: readonly KnownSymbolAlias[] = [
  { keyword: '贵州茅台', symbol: '600519', name: '贵州茅台' },
  { keyword: '茅台', symbol: '600519', name: '贵州茅台' },
  { keyword: '宁德时代', symbol: '300750', name: '宁德时代' },
  { keyword: '通富微电', symbol: '002156', name: '通富微电' },
  { keyword: '平安银行', symbol: '000001', name: '平安银行' },
  { keyword: '招商银行', symbol: '600036', name: '招商银行' },
  { keyword: '杭钢股份', symbol: '600126', name: '杭钢股份' },
  { keyword: '京沪高铁', symbol: '601816', name: '京沪高铁' },
  { keyword: '三七互娱', symbol: '002555', name: '三七互娱' },
  { keyword: '中国黄金', symbol: '600916', name: '中国黄金' },
  { keyword: '完美世界', symbol: '002624', name: '完美世界' },
  { keyword: '沪深300ETF', symbol: '510300', name: '沪深300ETF' },
  { keyword: '沪深300 ETF', symbol: '510300', name: '沪深300ETF' },
  { keyword: '300ETF', symbol: '510300', name: '沪深300ETF' },
  { keyword: '沪深300', symbol: '000300', name: '沪深300' },
  { keyword: '沪深 300', symbol: '000300', name: '沪深300' },
  { keyword: '创业板指数', symbol: '399006', name: '创业板指' },
  { keyword: '创业板指', symbol: '399006', name: '创业板指' },
  { keyword: '中证500', symbol: '000905', name: '中证500' },
  { keyword: '中证 500', symbol: '000905', name: '中证500' },
  { keyword: '科创50', symbol: '000688', name: '科创50' },
  { keyword: '科创 50', symbol: '000688', name: '科创50' },
];

const SYMBOL_CODE_PATTERN = /\b(?:6|0|3|5)\d{5}\b/g;

/**
 * Match aliases by longest non-overlapping span.
 *
 * A simple `includes` pass makes a phrase such as `沪深300ETF` resolve to both
 * the ETF and its shorter `沪深300` prefix. Selecting the longest spans first
 * gives every planning/prefetch/clarification caller the same unambiguous view.
 */
export function matchKnownSymbolAliases(
  input: string,
  aliases: readonly KnownSymbolAlias[] = KNOWN_SYMBOL_ALIASES
): KnownSymbolAliasMatch[] {
  const haystack = input.toLocaleLowerCase();
  const candidates: Array<KnownSymbolAliasMatch & { aliasIndex: number }> = [];

  aliases.forEach((alias, aliasIndex) => {
    const needle = alias.keyword.toLocaleLowerCase();
    if (!needle) return;

    let start = haystack.indexOf(needle);
    while (start >= 0) {
      candidates.push({
        ...alias,
        start,
        end: start + needle.length,
        aliasIndex,
      });
      start = haystack.indexOf(needle, start + 1);
    }
  });

  candidates.sort((left, right) =>
    (right.end - right.start) - (left.end - left.start) ||
    left.start - right.start ||
    left.aliasIndex - right.aliasIndex
  );

  const selected: Array<KnownSymbolAliasMatch & { aliasIndex: number }> = [];
  for (const candidate of candidates) {
    const overlaps = selected.some(
      (match) => candidate.start < match.end && candidate.end > match.start
    );
    if (!overlaps) selected.push(candidate);
  }

  return selected
    .sort((left, right) => left.start - right.start || left.aliasIndex - right.aliasIndex)
    .map(({ aliasIndex: _aliasIndex, ...match }) => match);
}

export function inferKnownSymbols(input: string): string[] {
  return Array.from(new Set(matchKnownSymbolAliases(input).map((match) => match.symbol)));
}

export function extractExplicitSymbolCodes(input: string): string[] {
  return Array.from(new Set(input.match(SYMBOL_CODE_PATTERN) ?? []));
}

export function inferQuantSymbolsFromText(input: string): string[] {
  return Array.from(new Set([
    ...extractExplicitSymbolCodes(input),
    ...inferKnownSymbols(input),
  ]));
}

/** Remove shorter parser fragments when the same extraction produced a containing name. */
export function keepLongestDistinctTextCandidates(candidates: readonly string[]): string[] {
  const unique = Array.from(new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean)));
  return unique.filter((candidate, index) => {
    const normalized = candidate.toLocaleLowerCase();
    return !unique.some((other, otherIndex) =>
      otherIndex !== index &&
      other.length > candidate.length &&
      other.toLocaleLowerCase().includes(normalized)
    );
  });
}
