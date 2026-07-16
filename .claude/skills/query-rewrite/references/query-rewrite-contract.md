# Query Rewrite Contract

## Purpose

`.quantpilot/query_rewrite.json` is the versioned, platform-owned input contract shared by planning, deterministic prefetch, and Agent skills. It prevents UI, planner, prefetch, and individual skills from inventing separate target-normalization rules.

## Required fields

| Field | Contract |
| --- | --- |
| `schemaVersion` | Must equal `3`. |
| `originalQuery` | Exact user-facing input before normalization. |
| `normalizedQuery` | Unicode-normalized, whitespace-bounded input. |
| `rewrittenQuery` | Execution summary; never a user quote. |
| `status` | `ready`, `partial`, `needs_clarification`, or `refused`. |
| `confidence` | Number between `0` and `1`. |
| `capabilityHint` | Deterministic task-family hint; manual platform selection may override it. |
| `targetCandidates` | Cleaned names or explicit codes submitted for resolution. |
| `resolvedSymbols` | Ordered standard instruments accepted for data retrieval. |
| `unresolvedTargets` | Candidates with no accepted result or unavailable resolution. |
| `ambiguousTargets` | Candidates with multiple equal-priority results. |
| `timeRange` | Explicit structured range, or `null` for capability defaults. |
| `analysisFocus` | Stable focus ID and user-facing label. |
| `outputIntent` | `dashboard` or `answer`. |
| `broadUniverse` | Whether the request intentionally targets a market universe instead of named securities. |
| `safety` | Deterministic `allow` or `refuse` decision, stable code, and user-facing explanation. |
| `issues` | Typed resolution and clarification issues. |
| `execution` | Deterministic draft plus bounded LLM attempt, strategy, model, latency, status, confidence, error code, and token usage. |

## Hybrid execution

`execution.strategy` is one of:

- `deterministic`: rules and Resolver API were sufficient; no LLM result influenced the contract.
- `hybrid_llm`: a schema-valid LLM semantic result passed literal-span checks and was applied before Resolver confirmation.
- `deterministic_fallback`: the LLM path was selected but unavailable, timed out, failed, or returned invalid output; the platform preserved the deterministic result.

`execution.llm.status` is `not_requested`, `not_needed`, `applied`, `skipped_unconfigured`, `invalid_output`, `timed_out`, or `failed`. Only `applied` may set `execution.llm.applied=true`.

The LLM does not own instrument identity. Its `targetCandidates` must be literal substrings or explicit codes from `normalizedQuery`; the platform rejects invented targets and runs every accepted candidate through `/api/v1/symbols/resolve`.

## Resolved symbol

Every `resolvedSymbols[]` item contains:

```json
{
  "query": "北方稀土",
  "symbol": "600111",
  "name": "北方稀土",
  "market": "SH",
  "assetType": "stock",
  "secid": "1.600111",
  "source": "eastmoney",
  "confidence": 0.86
}
```

`symbol` is the primary key used by downstream APIs. `market`, `assetType`, and `secid` prevent stock/index/ETF confusion.

## Status invariants

### ready

- All named candidates are resolved.
- `ambiguousTargets` and `unresolvedTargets` are empty.
- A broad-universe request may be ready with no resolved symbols.

### partial

- At least one target is resolved and at least one is unresolved.
- Multi-target comparison and portfolio requests normally require clarification before continuing because omission changes semantics.

### needs_clarification

- No required target was supplied or resolved, or
- at least one candidate remains ambiguous.

Do not describe this state as a market-data outage unless an issue is specifically `SYMBOL_RESOLVER_UNAVAILABLE`.

### refused

- `safety.decision` is `refuse` with a stable code and non-empty message.
- No resolver, data API, Agent, or dashboard execution may follow.
- Guaranteed-return, certain-profit, and certain-limit-up requests use `GUARANTEED_RETURN_REQUEST` and should offer evidence-based research as the safe alternative.

## Issue codes

| Code | Meaning | Retry |
| --- | --- | --- |
| `TARGET_NOT_FOUND` | Resolver returned no acceptable security. | No; change or clarify the target. |
| `TARGET_AMBIGUOUS` | Multiple equal-priority securities remain. | No; ask the user to choose. |
| `SYMBOL_RESOLVER_UNAVAILABLE` | Resolver timed out or returned an infrastructure error. | Yes, when platform policy permits. |
| `GUARANTEED_RETURN_REQUEST` | The request asks for an impossible deterministic return or price-move promise. | No; return the safety explanation. |

## Handoff rules

1. Query Rewrite owns natural-language normalization and symbol resolution.
2. Run Planner consumes Query Rewrite semantic facts, owns defaults and execution order, and may override capability only for an explicit manual platform selection.
3. Data skills own read-only API retrieval using resolved standard symbols.
4. Data Quality owns source, freshness, missing-field, and limitation evidence.
5. Dashboard Visualization consumes only the run plan and validated final/evidence artifacts.
