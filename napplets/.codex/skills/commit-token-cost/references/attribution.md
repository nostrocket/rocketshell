# Commit attribution

## Plain-language meaning

Treat each commit as a time window. For a commit made at 10:30 whose first
parent was made at 10:00, select Codex token events that:

- record a working directory inside the selected Git worktree;
- occurred after 10:00; and
- occurred at or before 10:30.

Assign all selected usage to the 10:30 commit. Use the first parent's commit
time as the lower boundary for merge commits. The interval is therefore
`(first-parent committer time, commit committer time]`.

Codex logs contain cumulative token counters. Subtract each prior counter from
the next counter before summing, so repeated snapshots are not counted again.
Treat a decreasing counter as a reset. Price the resulting input, cached input,
and output deltas using the model recorded with each event.

## What the estimate establishes

The result establishes how much recorded Codex usage falls inside that worktree
and time interval. It does not establish that every selected prompt caused the
commit or that every line in the commit came from Codex. The script does not
inspect diffs or infer prompt-to-file causality.

Attribution can skew when:

- concurrent work uses the same worktree during the interval;
- relevant work happened before the parent commit or after the target commit;
- a session recorded a working directory outside the selected worktree;
- commit times changed through amend or rebase;
- clocks differ; or
- uncommitted work overlaps the interval.

Cost trailers use a two-pass workflow because a commit must exist before its
time window can be measured. Calculate the provisional commit, then amend only
its message with the estimate. The final commit time can differ slightly, so
the trailer describes the pre-amend commit's near-final interval.

Cache-write tokens remain in the uncached-input bucket under the skill's
`input - cached input` formula. Report every value as an API-equivalent estimate,
not invoice parity or actual Codex billing.
