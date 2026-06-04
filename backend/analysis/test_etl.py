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

from etl import derive_dt, flatten_record, is_skippable_key, parse_log_lines


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


class SkippableKeyTest(unittest.TestCase):
    def test_skips_data_subpath_and_permission_markers(self):
        base = "model-logs/AWSLogs/123456789012/BedrockModelInvocationLogs/us-east-1/2026/06/03/06/"
        self.assertTrue(is_skippable_key(base + "data/req-1_input.json.gz"))
        self.assertTrue(is_skippable_key("model-logs/permission-check/marker"))
        self.assertFalse(is_skippable_key(base + "2026-06-03T06_abc123.json.gz"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
