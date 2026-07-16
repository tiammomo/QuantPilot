---
name: query-rewrite
description: Rewrite natural-language quantitative research questions into the platform-owned structured query contract before planning or data retrieval. Use when a request mentions securities, markets, time ranges, comparisons, fundamentals, technical analysis, events, strategies, backtests, portfolios, or follow-up changes whose targets and intent must be normalized consistently.
---

# QuantPilot Query Rewrite

Consume the platform-generated `.quantpilot/query_rewrite.json` before interpreting a quantitative request. Treat it as the authoritative bridge between the user's wording, the run plan, and API-based data skills. The platform uses deterministic parsing first and invokes schema-bound LLM semantics only for complex or low-confidence inputs.

> `.quantpilot/**` is platform-owned and read-only. Never create, edit, delete, or repair the rewrite artifact from the Agent runtime.

## Workflow

1. Read the rewrite contract supplied in the Task Packet or `.quantpilot/query_rewrite.json`.
2. Use `resolvedSymbols[]` as the standard target list. Preserve its order and carry `symbol`, `market`, `assetType`, and `secid` into subsequent data requests.
3. Inspect `execution.strategy` and `execution.llm`. Accept `hybrid_llm` only when `llm.applied=true`; `deterministic_fallback` is a usable rules result, not an analysis failure.
4. Use `timeRange`, `analysisFocus`, `capabilityHint`, and `outputIntent` as the semantic facts for the run plan. Do not reclassify a financial metric comparison as a multi-security comparison merely because the wording contains “compare”. Only an explicit manual platform capability selection may override the hint.
5. Respect the status gate:
   - `ready`: continue to `run-planner` and the required API-based data skills.
   - `partial`: continue only for resolved targets when the omitted targets do not change the requested comparison or portfolio semantics; otherwise ask one concise clarification.
   - `needs_clarification`: ask the questions implied by `issues[]` and stop before data retrieval.
   - `refused`: return `safety.message` and stop before symbol resolution, data retrieval, Agent execution, or dashboard generation.
6. Keep `originalQuery` for user-visible wording and use `rewrittenQuery` only as an execution summary. Never present rewritten text as a verbatim user quote.
7. Report issue codes exactly. Distinguish `TARGET_NOT_FOUND`, `TARGET_AMBIGUOUS`, and `SYMBOL_RESOLVER_UNAVAILABLE`; do not collapse them into “data unavailable.”

## Hybrid safety boundary

- Do not call an LLM again from the Agent. The platform owns the single bounded fallback.
- Treat LLM semantics as untrusted until the platform schema and literal-span checks pass.
- Never accept an LLM-produced ticker as resolved. Only `resolvedSymbols[]` returned after the market resolver is authoritative.
- Continue with deterministic results when `execution.llm.status` is `skipped_unconfigured`, `invalid_output`, `timed_out`, or `failed`; use the top-level status gate to decide whether clarification is still required.
- Treat `safety.decision=refuse` as a deterministic platform decision. Never ask for a ticker to satisfy a guaranteed-return, certain-profit, or certain-limit-up request.

## LLM configuration contract

- Read the project-safe LLM profile from `.quantpilot/manifest.json.llm` or `run_plan.json.llm` when auditing provider behavior.
- Require `provider`, `model`, `baseUrl`, `credentialEnv`, `agent`, and `queryRewrite` configuration. The files contain only the credential environment-variable name, never the secret value.
- Do not override the project profile from Agent code. Query Rewrite uses the same DeepSeek provider boundary and its own bounded mode, timeout, and retry policy.

## Validation

Validate a received artifact when fields are missing or the status conflicts with the symbol list:

```bash
python .claude/skills/query-rewrite/scripts/validate_query_rewrite.py \
  --input .quantpilot/query_rewrite.json
```

The script prints deterministic JSON, performs no network calls, and never writes files. A non-zero exit means the platform contract must be regenerated before continuing.

Read [query-rewrite-contract.md](references/query-rewrite-contract.md) when handling hybrid execution, ambiguity, partial resolution, schema validation, or API error mapping.

## API handoff

- The platform creates the contract through `POST /api/quant/query/rewrite`; Agent code consumes the artifact rather than calling this platform endpoint again.
- UI preview calls remain deterministic; execution calls may use the bounded LLM fallback.
- Resolve only platform-approved missing targets through `GET /api/v1/symbols/resolve`.
- Pass standard codes—not raw Chinese names—to quote, history, indicator, fundamental, event, and backtest APIs.
- Preserve API `source`, `as_of`, `fetched_at`, `fetch`, and `data_quality` in evidence.
- Do not retry `TARGET_NOT_FOUND` unchanged. Retry `SYMBOL_RESOLVER_UNAVAILABLE` only when the platform marks it retryable.

## Completion boundary

Complete this skill when the target set, time range, analysis focus, capability hint, output intent, and clarification state are internally consistent. Data retrieval and dashboard generation belong to subsequent skills.
