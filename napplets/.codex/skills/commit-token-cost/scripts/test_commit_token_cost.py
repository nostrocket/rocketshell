#!/usr/bin/env python3
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("commit_token_cost.py")
SPEC = importlib.util.spec_from_file_location("commit_token_cost", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def write_record(handle, timestamp, record_type, payload):
    handle.write(json.dumps({"timestamp": timestamp, "type": record_type, "payload": payload}) + "\n")


def token_payload(input_tokens, cached, output, reasoning, total=None):
    usage = {
        "input_tokens": input_tokens,
        "cached_input_tokens": cached,
        "output_tokens": output,
        "reasoning_output_tokens": reasoning,
        "total_tokens": total if total is not None else input_tokens + output,
    }
    return {"type": "token_count", "info": {"total_token_usage": usage}}


class CommitTokenCostTests(unittest.TestCase):
    def make_log(self, codex_home, repo):
        folder = codex_home / "sessions" / "2026" / "01" / "01"
        folder.mkdir(parents=True)
        path = folder / "rollout-2026-01-01T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
        with path.open("w", encoding="utf-8") as handle:
            write_record(
                handle,
                "1970-01-01T00:02:00Z",
                "session_meta",
                {"cwd": str(repo), "model_provider": "openai"},
            )
            write_record(handle, "1970-01-01T00:02:01Z", "turn_context", {"cwd": str(repo), "model": "gpt-5"})
            write_record(handle, "1970-01-01T00:02:30Z", "event_msg", token_payload(100, 40, 20, 10))
            # Repeated cumulative sample must add zero, not double-count.
            write_record(handle, "1970-01-01T00:02:31Z", "event_msg", token_payload(100, 40, 20, 10))
            write_record(handle, "1970-01-01T00:02:40Z", "event_msg", token_payload(180, 60, 50, 20))
            # Counter decrease means reset; current totals become next delta.
            write_record(handle, "1970-01-01T00:02:50Z", "turn_context", {"cwd": str(repo), "model": "gpt-4.1"})
            write_record(handle, "1970-01-01T00:02:50Z", "event_msg", token_payload(20, 5, 10, 3))
            # Update cumulative state outside repo, but do not yield event.
            write_record(handle, "1970-01-01T00:02:55Z", "turn_context", {"cwd": str(repo.parent / "elsewhere"), "model": "gpt-4.1"})
            write_record(handle, "1970-01-01T00:02:55Z", "event_msg", token_payload(30, 5, 12, 3))
        return path

    def test_repo_filter_cumulative_delta_reset_and_models(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            repo.mkdir()
            codex_home = root / "codex"
            self.make_log(codex_home, repo)
            events = list(MODULE.iter_usage_events(codex_home, repo.resolve()))

        self.assertEqual(len(events), 3)
        self.assertEqual(events[0]["input_tokens"], 100)
        self.assertEqual(events[1]["input_tokens"], 80)
        self.assertEqual(events[1]["cached_input_tokens"], 20)
        self.assertEqual(events[2]["input_tokens"], 20)
        self.assertEqual(events[2]["model"], "gpt-4.1")
        self.assertTrue(events[2]["counter_reset"])

    def test_commit_boundaries_are_parent_exclusive_commit_inclusive(self):
        commits = [
            {"hash": "one", "parent_timestamp": 100, "timestamp": 160},
            {"hash": "two", "parent_timestamp": 160, "timestamp": 180},
        ]
        events = [
            {"timestamp": 100},
            {"timestamp": 150},
            {"timestamp": 160},
            {"timestamp": 170},
            {"timestamp": 181},
        ]
        buckets = MODULE.attribute_events(commits, events)
        self.assertEqual([row["timestamp"] for row in buckets["one"]], [150, 160])
        self.assertEqual([row["timestamp"] for row in buckets["two"]], [170])

    def test_cached_cost_and_reasoning_not_double_counted(self):
        prices = {
            "unit_tokens": 100,
            "long_context_threshold_input_tokens": 272000,
            "rates": {"gpt-5": {"input": "2", "cached_input": "0.5", "output": "10"}},
        }
        event = {
            "model": "gpt-5",
            "input_tokens": 100,
            "cached_input_tokens": 40,
            "output_tokens": 20,
            "reasoning_output_tokens": 10,
            "counter_reset": False,
        }
        result = MODULE.summarize_events([event], prices)
        self.assertEqual(result["uncached_input_tokens"], 60)
        self.assertEqual(result["api_equivalent_cost_usd"], "3.4")
        self.assertEqual(result["models"][0]["output_cost_usd"], "2")

    def test_multiple_models_aggregate(self):
        prices = {
            "unit_tokens": 100,
            "long_context_threshold_input_tokens": 272000,
            "rates": {
                "gpt-5": {"input": "1", "cached_input": "0.1", "output": "2"},
                "gpt-4.1": {"input": "2", "cached_input": "0.2", "output": "4"},
            },
        }
        base = {
            "input_tokens": 10,
            "cached_input_tokens": 0,
            "output_tokens": 10,
            "reasoning_output_tokens": 0,
            "counter_reset": False,
        }
        result = MODULE.summarize_events(
            [{**base, "model": "gpt-5"}, {**base, "model": "gpt-4.1"}], prices
        )
        self.assertEqual(len(result["models"]), 2)
        self.assertEqual(result["api_equivalent_cost_usd"], "0.9")

    def test_unknown_model_fails(self):
        event = {
            "model": "unpriced-model",
            "input_tokens": 1,
            "cached_input_tokens": 0,
            "output_tokens": 1,
            "reasoning_output_tokens": 0,
            "counter_reset": False,
        }
        with self.assertRaisesRegex(MODULE.ReportError, "unknown model pricing: unpriced-model"):
            MODULE.summarize_events([event], {"unit_tokens": 1000000, "rates": {}})

    def test_long_context_rate_is_selected_per_call(self):
        prices = {
            "unit_tokens": 100,
            "long_context_threshold_input_tokens": 20,
            "rates": {
                "gpt-5": {
                    "input": "1",
                    "cached_input": "0.1",
                    "output": "2",
                    "long_input": "2",
                    "long_cached_input": "0.2",
                    "long_output": "3",
                }
            },
        }
        event = {
            "model": "gpt-5",
            "input_tokens": 30,
            "cached_input_tokens": 10,
            "output_tokens": 10,
            "reasoning_output_tokens": 4,
            "counter_reset": False,
        }
        result = MODULE.summarize_events([event], prices)
        self.assertEqual(result["models"][0]["context"], "long")
        self.assertEqual(result["api_equivalent_cost_usd"], "0.72")

    def test_inside_repo_rejects_sibling_prefix(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            repo.mkdir()
            sibling = root / "repo-other"
            sibling.mkdir()
            self.assertTrue(MODULE.inside_repo(repo / "nested", repo.resolve()))
            self.assertFalse(MODULE.inside_repo(sibling, repo.resolve()))


if __name__ == "__main__":
    unittest.main()
