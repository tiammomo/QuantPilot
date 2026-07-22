---
name: query-rewrite
description: Consume the platform-owned LLM-first quantitative query contract before planning or data retrieval. Use for securities, markets, time ranges, comparisons, fundamentals, technical analysis, events, strategies, backtests, portfolios, or follow-up requests.
---

# QuantPilot Query Rewrite

Consume `.data-agent/finance-query-rewrite.json` as the only semantic bridge between the user's wording, the run plan, and API-based data skills. QuantPilot calls the selected LLM once through a strict Tool Schema, checks every semantic evidence span against the original query, and then sends literal target names or codes to the independent symbol Resolver.

> `.data-agent/**` is platform-owned and read-only. Never create, edit, delete, or repair the rewrite artifact from the Agent runtime.

## Workflow

1. Read the rewrite contract supplied in the Task Packet or `.data-agent/finance-query-rewrite.json`.
2. Inspect `execution.strategy` and `execution.llm` first:
   - `llm_primary` requires `llm.applied=true` and `llm.status=applied`.
   - `llm_unavailable` is a hard semantic gate. Stop before planning or data retrieval and surface the retry guidance in `issues[]`.
   - `safety_refusal` stops the request before model, Resolver, data, Agent, or dashboard execution.
3. For `llm_primary`, use `resolvedSymbols[]` as the ordered target list and carry `symbol`, `market`, `assetType`, and `secid` into data requests.
4. Use `timeRange`, `analysisFocus`, `capabilityHint`, `outputIntent`, and `broadUniverse` as authoritative semantics. Do not reparse the original query with keywords or regular expressions.
5. Respect the top-level status gate:
   - `ready`: continue to `run-planner` and required data skills.
   - `partial`: continue only when omitting unresolved targets cannot change comparison or portfolio semantics; otherwise clarify.
   - `needs_clarification`: surface the issue or clarification question and stop before data retrieval.
   - `refused`: return `safety.message` and stop.
6. Keep `originalQuery` for user-visible wording. `rewrittenQuery` is an execution summary, never a verbatim quote.
7. Preserve issue codes exactly: `QUERY_REWRITE_LLM_UNAVAILABLE`, `TARGET_NOT_FOUND`, `TARGET_AMBIGUOUS`, `SYMBOL_RESOLVER_UNAVAILABLE`, and `GUARANTEED_RETURN_REQUEST` have different remediation paths.

## Trust boundary

- Do not call a second semantic model from the Agent. The platform owns the single bounded Query Rewrite call.
- LLM fields are accepted only after Tool Schema and literal-evidence validation.
- The LLM never owns instrument identity. Only `resolvedSymbols[]` returned after `/api/v1/symbols/resolve` is authoritative.
- There is no keyword-derived semantic fallback. Model unavailability produces `llm_unavailable` and prevents downstream execution.
- The deterministic guaranteed-return gate is a safety policy, not a semantic parser.

## Configuration contract

- Audit executor/model identity in `.data-agent/workspace.json.runtime` and the secret-free provider profile in `.data-agent/finance-run-plan.json.llm`.
- `provider`, `model`, `baseUrl`, `credentialEnv`, `agent`, and `queryRewrite` must be present. Only the credential environment-variable name may be persisted.
- The default profile is local Qwen through ModelPort. ModelPort-hosted DeepSeek, optional direct DeepSeek, and other registered OpenAI-compatible models use the same Query Rewrite contract.
- If Query Rewrite is disabled or its credential is unavailable, the request fails closed; it does not become a model-free rewrite.

## Validation

```bash
python .moagent/skills/query-rewrite/scripts/validate_query_rewrite.py \
  --input .data-agent/finance-query-rewrite.json
```

The validator performs no network calls and writes no files. A non-zero exit means the contract must be regenerated before continuing. Read [query-rewrite-contract.md](references/query-rewrite-contract.md) for schema and state invariants.

## API handoff

- The platform creates the artifact through `POST /api/quant/query/rewrite`; Agent code consumes it and must not call the platform endpoint again.
- Both `preview` and `execution` purposes use the selected LLM. Preview is not a keyword-only path.
- Data APIs receive standard codes from `resolvedSymbols`, never raw names guessed from the question.
- Preserve API `source`, `as_of`, `fetched_at`, `fetch`, and `data_quality` in evidence.
- Do not retry `TARGET_NOT_FOUND` unchanged. Retry infrastructure failures only when the issue is marked retryable.

Complete this skill when the rewrite status, resolved target set, period, focus, capability, output intent, and clarification state are internally consistent. Data retrieval and dashboard generation belong to subsequent skills.
