---
name: commit-token-cost
description: Estimate Codex token usage and API-equivalent cost in USD and bitcoin sats for individual Git commits from local Codex JSONL logs, pinned official OpenAI Standard API prices, and a BTC/USD spot quote. Use when asked for token counts, dollar or sat value, AI cost, or model usage per commit, revision, or commit range.
---

# Commit Token Cost

Use bundled deterministic script. Report USD and sat values as **API-equivalent estimates**, never actual Codex billing.

## Workflow

1. Check `references/prices.json` source URL and retrieval date. If current official Standard API prices changed, update snapshot and retrieval date before calculating.
2. Run script from target repository:

```bash
python3 /absolute/path/to/commit-token-cost/scripts/commit_token_cost.py --repo . --commit HEAD
python3 /absolute/path/to/commit-token-cost/scripts/commit_token_cost.py --repo . --range 'main~5..main'
python3 /absolute/path/to/commit-token-cost/scripts/commit_token_cost.py --repo . --range 'main~5..main' --format json
python3 /absolute/path/to/commit-token-cost/scripts/commit_token_cost.py --repo . --commit HEAD --btc-usd 50000
```

3. Use live unauthenticated [Coinbase `BTC-USD` spot price](https://docs.cdp.coinbase.com/coinbase-business/track-apis/prices) by default. Use `--btc-usd` only for reproducible or offline runs.
4. Report attribution method, uncovered limitations, API pricing source/date, and BTC quote source/time with result.
5. Stop on unknown model pricing or unavailable BTC quote. Never substitute a similar model, stale quote, or invented rate.

## Accounting

- Derive per-call usage from cumulative counter deltas. Treat decreasing counters as reset. Ignore unchanged cumulative samples. Fall back to `last_token_usage` only when cumulative usage is absent.
- Calculate uncached input as `input_tokens - cached_input_tokens`; price cached input separately.
- Price `output_tokens` once. `reasoning_output_tokens` is a reported subset of output, not extra billable output.
- Select official long-context rates per call when input exceeds snapshot threshold and that model has a published long-context rate.
- Deduplicate copied JSONL events by timestamp and cumulative usage fingerprint.
- Calculate each USD price component with full precision, round it upward to two decimal places, then sum reported components for totals.
- Convert each rounded reported USD estimate with `USD / BTC-USD * 100,000,000`, rounded to nearest sat.

For routine calculations, use the script's attribution label without loading more
context. Read [attribution details](references/attribution.md) only when asked to
explain, assess, or interpret commit attribution or its accuracy.

## Privacy

Read only metadata, timestamps, model names, working directories, and token counters. Never print prompts, responses, tool payloads, credentials, or full session records.
