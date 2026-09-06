---
name: commit-token-cost
description: Estimate Codex token usage and API-equivalent USD cost for individual Git commits from local Codex JSONL logs and pinned official OpenAI Standard API prices. Use when asked for token counts, dollar value, AI cost, or model usage per commit, revision, or commit range.
---

# Commit Token Cost

Use bundled deterministic script. Report values as **API-equivalent estimates**, never actual Codex billing.

## Workflow

1. Check `references/prices.json` source URL and retrieval date. If current official Standard API prices changed, update snapshot and retrieval date before calculating.
2. Run script from target repository:

```bash
python3 /absolute/path/to/commit-token-cost/scripts/commit_token_cost.py --repo . --commit HEAD
python3 /absolute/path/to/commit-token-cost/scripts/commit_token_cost.py --repo . --range 'main~5..main'
python3 /absolute/path/to/commit-token-cost/scripts/commit_token_cost.py --repo . --range 'main~5..main' --format json
```

3. Report attribution method, uncovered limitations, pricing source, and retrieval date with result.
4. Stop on unknown model pricing. Never substitute a similar model or invent a rate. Add exact official rate to snapshot only after verifying source.

## Attribution and accounting

- Filter sessions by a recorded `cwd` inside selected Git worktree.
- Assign an event to commit when timestamp is after first parent's committer timestamp and at or before commit's committer timestamp.
- Derive per-call usage from cumulative counter deltas. Treat decreasing counters as reset. Ignore unchanged cumulative samples. Fall back to `last_token_usage` only when cumulative usage is absent.
- Calculate uncached input as `input_tokens - cached_input_tokens`; price cached input separately.
- Price `output_tokens` once. `reasoning_output_tokens` is a reported subset of output, not extra billable output.
- Select official long-context rates per call when input exceeds snapshot threshold and that model has a published long-context rate.
- Deduplicate copied JSONL events by timestamp and cumulative usage fingerprint.

This time-window method cannot prove causal authorship. Concurrent work in same worktree, uncommitted work, rebases, amended timestamps, clocks, sessions recorded outside worktree, and work performed before first-parent boundary can under- or over-attribute usage. Cache-write tokens remain in uncached input because requested accounting is `input - cached`; estimate does not claim invoice parity.

## Privacy

Read only metadata, timestamps, model names, working directories, and token counters. Never print prompts, responses, tool payloads, credentials, or full session records.
