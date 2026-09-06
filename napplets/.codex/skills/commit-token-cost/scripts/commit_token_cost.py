#!/usr/bin/env python3
"""Estimate API-equivalent Codex token cost per Git commit."""

import argparse
import json
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_HALF_UP
from pathlib import Path


USAGE_KEYS = (
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
)
BTC_SPOT_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot"
BTC_SPOT_DOCS_URL = "https://docs.cdp.coinbase.com/coinbase-business/track-apis/prices"
SATS_PER_BTC = Decimal("100000000")
USD_CENT = Decimal("0.01")


class ReportError(Exception):
    """Expected input or repository error."""


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Estimate API-equivalent USD cost per Git commit from Codex logs."
    )
    selector = parser.add_mutually_exclusive_group()
    selector.add_argument("--commit", default=None, help="Single Git revision (default: HEAD).")
    selector.add_argument("--range", dest="commit_range", help="Revision range accepted by git rev-list.")
    parser.add_argument("--repo", default=".", help="Git worktree path (default: current directory).")
    parser.add_argument(
        "--codex-home",
        default=str(Path.home() / ".codex"),
        help="Codex data directory (default: ~/.codex).",
    )
    parser.add_argument(
        "--prices",
        default=str(Path(__file__).resolve().parent.parent / "references" / "prices.json"),
        help="Pinned pricing JSON path.",
    )
    parser.add_argument(
        "--btc-usd",
        default=None,
        help="BTC/USD spot-price override; skips live Coinbase lookup.",
    )
    parser.add_argument("--format", choices=("human", "json"), default="human")
    return parser.parse_args(argv)


def run_git(repo, *args):
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        detail = result.stderr.strip().splitlines()
        raise ReportError(detail[-1] if detail else "git command failed")
    return result.stdout.strip()


def resolve_repo(path):
    root = run_git(Path(path).expanduser().resolve(), "rev-parse", "--show-toplevel")
    return Path(root).resolve()


def commit_record(repo, revision):
    raw = run_git(repo, "show", "-s", "--format=%H%x00%P%x00%ct%x00%cI%x00%s", revision)
    parts = raw.split("\0", 4)
    if len(parts) != 5:
        raise ReportError(f"could not read commit metadata for {revision}")
    parents = parts[1].split()
    parent_timestamp = None
    if parents:
        parent_timestamp = int(run_git(repo, "show", "-s", "--format=%ct", parents[0]))
    return {
        "hash": parts[0],
        "parents": parents,
        "parent_timestamp": parent_timestamp,
        "timestamp": int(parts[2]),
        "committed_at": parts[3],
        "subject": parts[4],
    }


def select_commits(repo, revision=None, commit_range=None):
    if commit_range:
        hashes = run_git(repo, "rev-list", "--reverse", "--first-parent", commit_range).splitlines()
        if not hashes:
            raise ReportError(f"range selects no commits: {commit_range}")
        return [commit_record(repo, value) for value in hashes]
    return [commit_record(repo, revision or "HEAD")]


def session_id(path):
    stem = path.stem
    return stem.rsplit("-", 5)[-5:] if stem.startswith("rollout-") else [stem]


def iter_log_paths(codex_home):
    selected = {}
    for dirname in ("sessions", "archived_sessions"):
        root = codex_home / dirname
        if not root.exists():
            continue
        for path in root.rglob("*.jsonl"):
            key = tuple(session_id(path))
            selected.setdefault(key, path)
    yield from sorted(selected.values())


def inside_repo(cwd, repo):
    if not cwd:
        return False
    try:
        Path(cwd).expanduser().resolve().relative_to(repo)
        return True
    except (OSError, ValueError):
        return False


def parse_timestamp(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def usage_values(usage):
    return {key: int(usage.get(key) or 0) for key in USAGE_KEYS}


def usage_delta(current, previous):
    if previous is None:
        return dict(current), False
    if all(current[key] >= previous[key] for key in USAGE_KEYS):
        return {key: current[key] - previous[key] for key in USAGE_KEYS}, False
    return dict(current), True


def event_fingerprint(timestamp, usage):
    return (timestamp, *(usage[key] for key in USAGE_KEYS))


def iter_usage_events(codex_home, repo):
    seen = set()
    for path in iter_log_paths(codex_home):
        cwd = None
        model = None
        provider = None
        previous = None
        try:
            handle = path.open("r", encoding="utf-8", errors="replace")
        except OSError as error:
            print(f"warning: cannot read Codex log {path}: {error}", file=sys.stderr)
            continue
        with handle:
            for line_number, line in enumerate(handle, 1):
                if not any(marker in line for marker in ('"session_meta"', '"turn_context"', '"token_count"')):
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError as error:
                    print(
                        f"warning: invalid JSON in {path}:{line_number}: {error.msg}",
                        file=sys.stderr,
                    )
                    continue
                payload = obj.get("payload") or {}
                record_type = obj.get("type")
                if record_type == "session_meta":
                    cwd = cwd or payload.get("cwd")
                    provider = provider or payload.get("model_provider")
                    continue
                if record_type == "turn_context":
                    cwd = payload.get("cwd") or cwd
                    model = payload.get("model") or model
                    continue
                if record_type != "event_msg" or payload.get("type") != "token_count":
                    continue
                info = payload.get("info") or {}
                cumulative_raw = info.get("total_token_usage")
                if cumulative_raw:
                    cumulative = usage_values(cumulative_raw)
                    delta, reset = usage_delta(cumulative, previous)
                    previous = cumulative
                    fingerprint = event_fingerprint(obj.get("timestamp"), cumulative)
                    if fingerprint in seen:
                        continue
                    seen.add(fingerprint)
                else:
                    last = info.get("last_token_usage")
                    if not last:
                        continue
                    delta = usage_values(last)
                    reset = False
                timestamp = parse_timestamp(obj.get("timestamp"))
                if not timestamp or not model or provider not in (None, "openai"):
                    continue
                if not inside_repo(cwd, repo):
                    continue
                if not any(delta.values()):
                    continue
                delta.update({"timestamp": timestamp, "model": model, "counter_reset": reset})
                yield delta


def attribute_events(commits, events):
    buckets = {commit["hash"]: [] for commit in commits}
    for event in events:
        for commit in commits:
            lower = commit["parent_timestamp"]
            if (lower is None or event["timestamp"] > lower) and event["timestamp"] <= commit["timestamp"]:
                buckets[commit["hash"]].append(event)
                break
    return buckets


def load_prices(path):
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        raise ReportError(f"cannot read pricing snapshot {path}: {error}") from error
    if data.get("tier") != "standard" or not data.get("rates"):
        raise ReportError("pricing snapshot must contain Standard rates")
    return data


def positive_decimal(value, label):
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError) as error:
        raise ReportError(f"{label} is not a valid decimal: {value}") from error
    if not amount.is_finite() or amount <= 0:
        raise ReportError(f"{label} must be a positive finite decimal")
    return amount


def bitcoin_quote(override=None, runner=subprocess.run, now=None):
    if override is not None:
        return {
            "btc_usd": str(positive_decimal(override, "--btc-usd")),
            "source_url": None,
            "source_documentation_url": BTC_SPOT_DOCS_URL,
            "source": "command-line --btc-usd override",
            "retrieved_at": (now or datetime.now(timezone.utc)).isoformat(),
        }

    try:
        response = runner(
            [
                "curl",
                "--fail",
                "--silent",
                "--show-error",
                "--max-time",
                "10",
                "--header",
                "Accept: application/json",
                BTC_SPOT_URL,
            ],
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError as error:
        raise ReportError(f"Coinbase BTC/USD spot lookup failed: {error}") from error
    if response.returncode:
        detail = response.stderr.strip().splitlines()
        raise ReportError(
            f"Coinbase BTC/USD spot lookup failed: "
            f"{detail[-1] if detail else f'curl exited {response.returncode}'}"
        )
    try:
        payload = json.loads(response.stdout)
    except (TypeError, json.JSONDecodeError) as error:
        raise ReportError(f"Coinbase BTC/USD spot response is invalid JSON: {error}") from error
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict) or data.get("currency") != "USD":
        raise ReportError("Coinbase BTC/USD spot response has unexpected currency or shape")
    return {
        "btc_usd": str(positive_decimal(data.get("amount"), "Coinbase BTC/USD spot price")),
        "source_url": BTC_SPOT_URL,
        "source_documentation_url": BTC_SPOT_DOCS_URL,
        "source": "Coinbase BTC-USD spot price",
        "retrieved_at": (now or datetime.now(timezone.utc)).isoformat(),
    }


def add_bitcoin_estimates(report, quote):
    btc_usd = positive_decimal(quote["btc_usd"], "BTC/USD spot price")
    for commit in report["commits"]:
        cost_usd = Decimal(commit["usage"]["api_equivalent_cost_usd"])
        sats = cost_usd * SATS_PER_BTC / btc_usd
        commit["usage"]["api_equivalent_cost_sats"] = int(
            sats.to_integral_value(rounding=ROUND_HALF_UP)
        )
    report["bitcoin_quote"] = quote
    return report


def format_usd(amount):
    """Round a USD cost upward to cents and preserve two decimal places."""
    return format(Decimal(amount).quantize(USD_CENT, rounding=ROUND_CEILING), ".2f")


def summarize_events(events, prices):
    totals = defaultdict(int)
    for key in (
        "input_tokens",
        "cached_input_tokens",
        "uncached_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
        "calls",
        "counter_resets",
    ):
        totals[key] = 0
    models = defaultdict(lambda: defaultdict(int))
    for event in events:
        uncached = event["input_tokens"] - event["cached_input_tokens"]
        if uncached < 0:
            raise ReportError(f"cached input exceeds input for model {event['model']}")
        rate = prices["rates"].get(event["model"])
        if rate is None:
            raise ReportError(f"unknown model pricing: {event['model']}")
        threshold = prices.get("long_context_threshold_input_tokens")
        long_context = bool(
            threshold and event["input_tokens"] > threshold and rate.get("long_input") is not None
        )
        context = "long" if long_context else "short"
        row = models[(event["model"], context)]
        row["input_tokens"] += event["input_tokens"]
        row["cached_input_tokens"] += event["cached_input_tokens"]
        row["uncached_input_tokens"] += uncached
        row["output_tokens"] += event["output_tokens"]
        row["reasoning_output_tokens"] += event["reasoning_output_tokens"]
        row["calls"] += 1
        row["counter_resets"] += int(event["counter_reset"])
    unit = Decimal(str(prices["unit_tokens"]))
    model_rows = []
    total_cost = Decimal("0")
    for (model, context), counts in sorted(models.items()):
        rate = prices["rates"][model]
        prefix = "long_" if context == "long" else ""
        input_rate = rate[f"{prefix}input"]
        cached_rate = rate[f"{prefix}cached_input"]
        output_rate = rate[f"{prefix}output"]
        if counts["cached_input_tokens"] and cached_rate is None:
            raise ReportError(f"official snapshot has no cached-input rate for model {model}")
        uncached_cost = Decimal(counts["uncached_input_tokens"]) * Decimal(input_rate) / unit
        cached_cost = (
            Decimal(counts["cached_input_tokens"]) * Decimal(cached_rate) / unit
            if cached_rate is not None
            else Decimal("0")
        )
        output_cost = Decimal(counts["output_tokens"]) * Decimal(output_rate) / unit
        reported_uncached_cost = format_usd(uncached_cost)
        reported_cached_cost = format_usd(cached_cost)
        reported_output_cost = format_usd(output_cost)
        reported_cost = format_usd(
            Decimal(reported_uncached_cost)
            + Decimal(reported_cached_cost)
            + Decimal(reported_output_cost)
        )
        total_cost += Decimal(reported_cost)
        row = dict(counts)
        row.update(
            {
                "model": model,
                "context": context,
                "rates_usd_per_million": {
                    "input": input_rate,
                    "cached_input": cached_rate,
                    "output": output_rate,
                },
                "uncached_input_cost_usd": reported_uncached_cost,
                "cached_input_cost_usd": reported_cached_cost,
                "output_cost_usd": reported_output_cost,
                "api_equivalent_cost_usd": reported_cost,
            }
        )
        model_rows.append(row)
        for key in (
            "input_tokens",
            "cached_input_tokens",
            "uncached_input_tokens",
            "output_tokens",
            "reasoning_output_tokens",
            "calls",
            "counter_resets",
        ):
            totals[key] += counts[key]
    result = dict(totals)
    result["api_equivalent_cost_usd"] = format_usd(total_cost)
    result["models"] = model_rows
    return result


def build_report(repo, commits, events, prices):
    buckets = attribute_events(commits, events)
    rows = []
    for commit in commits:
        row = dict(commit)
        row["usage"] = summarize_events(buckets[commit["hash"]], prices)
        rows.append(row)
    return {
        "label": "API-equivalent estimate; not actual Codex billing",
        "repository": str(repo),
        "attribution": "recorded cwd inside worktree; first-parent committer-time interval",
        "pricing": {
            key: prices[key]
            for key in (
                "source_url",
                "retrieved_on",
                "tier",
                "currency",
                "unit_tokens",
                "long_context_threshold_input_tokens",
            )
        },
        "commits": rows,
    }


def print_human(report):
    pricing = report["pricing"]
    quote = report["bitcoin_quote"]
    print(report["label"])
    print(f"Repository: {report['repository']}")
    print(f"Attribution: {report['attribution']}")
    print(f"Pricing: {pricing['tier']}, retrieved {pricing['retrieved_on']}")
    print(f"Source: {pricing['source_url']}")
    print(
        f"BTC/USD: ${Decimal(quote['btc_usd']):,.2f}, "
        f"{quote['source']}, retrieved {quote['retrieved_at']}"
    )
    print()
    print("Commit       Cost USD   Cost sats       Input      Cached     Output  Subject")
    for commit in report["commits"]:
        usage = commit["usage"]
        cost = Decimal(usage["api_equivalent_cost_usd"])
        print(
            f"{commit['hash'][:10]:10}  ${cost:>11.2f}  "
            f"{usage['api_equivalent_cost_sats']:>10,}  "
            f"{usage.get('input_tokens', 0):>10,}  {usage.get('cached_input_tokens', 0):>10,}  "
            f"{usage.get('output_tokens', 0):>9,}  {commit['subject']}"
        )
    print()
    print("Reasoning tokens are included in output tokens and are not added twice.")


def main(argv=None):
    try:
        args = parse_args(argv)
        repo = resolve_repo(args.repo)
        commits = select_commits(repo, args.commit, args.commit_range)
        prices = load_prices(Path(args.prices).expanduser().resolve())
        events = list(iter_usage_events(Path(args.codex_home).expanduser().resolve(), repo))
        report = build_report(repo, commits, events, prices)
        report = add_bitcoin_estimates(report, bitcoin_quote(args.btc_usd))
        if args.format == "json":
            print(json.dumps(report, indent=2, ensure_ascii=False))
        else:
            print_human(report)
        return 0
    except ReportError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
