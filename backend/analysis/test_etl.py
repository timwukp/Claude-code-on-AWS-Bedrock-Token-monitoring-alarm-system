"""
Offline unit tests for the PURE ETL parsing logic (no AWS, no pandas/pyarrow required).

Mirrors backend/lambdas/ingestion/parse.test.ts. Run with the stdlib only:

    python3 test_etl.py
    # or: python3 -m pytest test_etl.py

Only `parse_log_lines`, `flatten_record`, `derive_dt`, and `is_skippable_key` are exercised
here -- they have no boto3/pandas dependency, so these tests run in any Python 3 environment.
"""
import json
import unittest

from etl import (
    _to_int,
    CURATED_COLUMNS,
    day_prefix,
    derive_dt,
    flatten_record,
    is_skippable_key,
    parse_log_lines,
    plan_days,
    read_watermark,
    split_rows_by_window,
    write_watermark_text,
)


def _record(**overrides):
    base = {
        "schemaType": "ModelInvocationLog",
        "timestamp": "2026-06-03T06:54:27Z",
        "accountId": "123456789012",
        "region": "us-east-1",
        "requestId": "req-1",
        "operation": "InvokeModel",
        "modelId": "arn:aws:bedrock:us-east-1::inference-profile/us.anthropic.claude-x",
        "identity": {"arn": "arn:aws:iam::123456789012:user/alice"},
        "requestMetadata": {"tenant": "team-a", "project_id": "p1"},
        "input": {
            "inputTokenCount": 100,
            "cacheReadInputTokenCount": 40,
            "cacheWriteInputTokenCount": 10,
        },
        "output": {"outputTokenCount": 25},
    }
    base.update(overrides)
    return base


class ParseLogLinesTest(unittest.TestCase):
    def test_parses_newline_delimited_json(self):
        text = "\n".join(json.dumps(_record(requestId=f"req-{i}")) for i in range(3))
        rows = parse_log_lines(text)
        self.assertEqual(len(rows), 3)
        self.assertEqual({r["requestId"] for r in rows}, {"req-0", "req-1", "req-2"})

    def test_skips_blank_and_malformed_lines(self):
        text = "\n".join(
            [
                json.dumps(_record(requestId="ok-1")),
                "",
                "   ",
                "{not valid json",
                "[1, 2, 3]",  # valid JSON but not an object -> skipped
                json.dumps(_record(requestId="ok-2")),
            ]
        )
        rows = parse_log_lines(text)
        self.assertEqual([r["requestId"] for r in rows], ["ok-1", "ok-2"])

    def test_skips_records_missing_required_fields(self):
        # No requestId, and no timestamp -- both unusable for partition/attribution.
        text = "\n".join(
            [
                json.dumps({"timestamp": "2026-06-03T06:00:00Z", "input": {"inputTokenCount": 5}}),
                json.dumps({"requestId": "no-ts", "input": {"inputTokenCount": 5}}),
                json.dumps(_record(requestId="good")),
            ]
        )
        rows = parse_log_lines(text)
        self.assertEqual([r["requestId"] for r in rows], ["good"])

    def test_flattens_input_output_token_fields(self):
        rows = parse_log_lines(json.dumps(_record()))
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["inputTokenCount"], 100)
        self.assertEqual(row["cacheReadInputTokenCount"], 40)
        self.assertEqual(row["cacheWriteInputTokenCount"], 10)
        self.assertEqual(row["outputTokenCount"], 25)
        self.assertEqual(row["identityArn"], "arn:aws:iam::123456789012:user/alice")
        self.assertEqual(json.loads(row["requestMetadata"]), {"tenant": "team-a", "project_id": "p1"})

    def test_missing_token_fields_default_to_zero(self):
        rec = _record()
        del rec["input"]
        del rec["output"]
        del rec["identity"]
        del rec["requestMetadata"]
        row = flatten_record(rec)
        self.assertEqual(row["inputTokenCount"], 0)
        self.assertEqual(row["cacheReadInputTokenCount"], 0)
        self.assertEqual(row["cacheWriteInputTokenCount"], 0)
        self.assertEqual(row["outputTokenCount"], 0)
        self.assertIsNone(row["identityArn"])
        self.assertIsNone(row["requestMetadata"])

    def test_non_numeric_token_field_coerces_to_zero(self):
        row = flatten_record(_record(input={"inputTokenCount": "oops"}))
        self.assertEqual(row["inputTokenCount"], 0)

    def test_date_partition_derivation(self):
        self.assertEqual(derive_dt("2026-06-03T06:54:27Z"), "2026-06-03")
        self.assertEqual(derive_dt("2026-12-31T23:59:59.123Z"), "2026-12-31")
        self.assertEqual(derive_dt(""), "")
        rows = parse_log_lines(json.dumps(_record(timestamp="2026-01-15T00:00:00Z")))
        self.assertEqual(rows[0]["dt"], "2026-01-15")


class ToIntTest(unittest.TestCase):
    """feature-47: a hostile or corrupt count must read as 0, never raise or go negative."""

    def test_ordinary_and_missing(self):
        self.assertEqual(_to_int(42), 42)
        self.assertEqual(_to_int("7"), 7)
        self.assertEqual(_to_int(None), 0)
        self.assertEqual(_to_int("abc"), 0)

    def test_infinity_negative_and_huge(self):
        self.assertEqual(_to_int(float("inf")), 0)      # int(inf) raises OverflowError — was uncaught
        self.assertEqual(_to_int(1e309), 0)             # the JSON literal that parses to inf
        self.assertEqual(_to_int(-5), 0)
        self.assertEqual(_to_int(2**60), 0)


class SkippableKeyTest(unittest.TestCase):
    def test_skips_data_subpath_and_permission_markers(self):
        base = "model-logs/AWSLogs/123456789012/BedrockModelInvocationLogs/us-east-1/2026/06/03/06/"
        self.assertTrue(is_skippable_key(base + "data/req-1_input.json.gz"))
        self.assertTrue(is_skippable_key("model-logs/permission-check/marker"))
        self.assertFalse(is_skippable_key(base + "2026-06-03T06_abc123.json.gz"))


RESPONSES_BODY = {
    "model": "us.openai.gpt-6-luna",
    "input": [
        {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "a"}]},
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "b"}]},
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "c"}]},
    ],
    "stream": True,
    "prompt_cache_key": "k",
}


class ForeignBodyTest(unittest.TestCase):
    """2026-10-23: an OpenAI Responses-API body inside the table prefix killed every Athena query.
    The ETL must never choke on a body shape, whichever vendor produced it."""

    def test_responses_array_body_is_not_a_record(self):
        self.assertEqual(parse_log_lines(json.dumps(RESPONSES_BODY)), [])

    def test_responses_string_input_body_is_not_a_record(self):
        body = dict(RESPONSES_BODY, input="just a plain string prompt")
        self.assertEqual(parse_log_lines(json.dumps(body)), [])

    def test_anthropic_and_converse_bodies_are_not_records(self):
        anthropic = {"anthropic_version": "bedrock-2023-05-31", "messages": [{"role": "user", "content": "hi"}]}
        converse = {"messages": [{"role": "user", "content": [{"text": "hi"}]}], "inferenceConfig": {"maxTokens": 5}}
        self.assertEqual(parse_log_lines(json.dumps(anthropic) + "\n" + json.dumps(converse)), [])

    def test_record_with_foreign_input_shape_still_yields_zero_counts(self):
        # A record whose `input` is an array (never seen, but the SerDe failure mode) must not raise.
        rec = _record()
        rec["input"] = RESPONSES_BODY["input"]
        rows = parse_log_lines(json.dumps(rec))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["inputTokenCount"], 0)
        self.assertEqual(rows[0]["cacheReadInputTokenCount"], 0)

    def test_body_object_keys_are_skipped(self):
        self.assertTrue(is_skippable_key(
            "model-logs/AWSLogs/123456789012/BedrockModelInvocationLogs/us-east-1/2026/10/23/15/data/4bbdf99f-17f2_input.json.gz"
        ))
        self.assertTrue(is_skippable_key(".../2026/10/23/15/data/4bbdf99f-17f2_output.json.gz"))


class CuratedSchemaTest(unittest.TestCase):
    def test_flattened_row_has_exactly_the_curated_columns_plus_dt(self):
        row = flatten_record(_record())
        self.assertEqual(set(row) - {"dt"}, set(CURATED_COLUMNS))

    def test_token_columns_are_bigint_and_the_rest_strings(self):
        for col, t in CURATED_COLUMNS.items():
            self.assertEqual(t, "bigint" if col.endswith("TokenCount") else "string", col)


class IncrementalPlanTest(unittest.TestCase):
    """The daily run must not relist 300k keys: it processes the days since the watermark, always
    re-reading the previous day so late-arriving hour files are picked up (partitions are overwritten)."""

    def test_no_watermark_means_full_backfill(self):
        self.assertIsNone(plan_days(None, "2026-10-24"))

    def test_watermark_yesterday_reprocesses_yesterday_and_today(self):
        self.assertEqual(plan_days("2026-10-23", "2026-10-24"), ["2026-10-23", "2026-10-24"])

    def test_watermark_today_still_reprocesses_yesterday(self):
        self.assertEqual(plan_days("2026-10-24", "2026-10-24"), ["2026-10-23", "2026-10-24"])

    def test_gap_of_several_days_is_filled_in_order(self):
        self.assertEqual(
            plan_days("2026-10-20", "2026-10-24"),
            ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"],
        )

    def test_month_boundary(self):
        self.assertEqual(plan_days("2026-09-30", "2026-10-01"), ["2026-09-30", "2026-10-01"])

    def test_day_prefix_matches_bedrock_layout(self):
        root = "model-logs/AWSLogs/123456789012/BedrockModelInvocationLogs/us-east-1/"
        self.assertEqual(day_prefix(root, "2026-10-05"), root + "2026/10/05/")

    def test_watermark_round_trip_and_tolerance(self):
        self.assertEqual(read_watermark(write_watermark_text("2026-10-24")), "2026-10-24")
        self.assertIsNone(read_watermark(""))
        self.assertIsNone(read_watermark("{not json"))
        self.assertIsNone(read_watermark(json.dumps({"last_day": "not-a-date"})))

    def test_rows_outside_the_processed_days_are_set_aside(self):
        rows = [
            {"dt": "2026-10-23", "requestId": "a"},
            {"dt": "2026-10-24", "requestId": "b"},
            {"dt": "2026-10-25", "requestId": "c"},  # a file in today's folder holding tomorrow's timestamp
            {"dt": None, "requestId": "d"},
        ]
        inside, outside = split_rows_by_window(rows, ["2026-10-23", "2026-10-24"])
        self.assertEqual([r["requestId"] for r in inside], ["a", "b"])
        self.assertEqual([r["requestId"] for r in outside], ["c", "d"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
