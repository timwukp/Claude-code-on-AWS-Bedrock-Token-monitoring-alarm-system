"""Stdlib-only tests for the pure parts of the CI agents (run: python3 -m unittest test_agents).
boto3/botocore are stubbed so the modules import without the SDK installed."""
import os
import sys
import types
import unittest

os.environ.setdefault("AWS_ACCOUNT_ID", "111122223333")  # synthetic; stops the modules calling STS at import

for name in ("boto3", "botocore", "botocore.config"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["botocore.config"].Config = object  # type: ignore[attr-defined]
sys.modules["boto3"].client = lambda *a, **k: None  # type: ignore[attr-defined]

from qa_agent import extract_json, normalize_report  # noqa: E402
from bugfix_agent import diff_is_confined, diff_paths, extract_diff  # noqa: E402


class NormalizeReportTest(unittest.TestCase):
    def test_findings_force_fail_even_when_agent_says_pass(self):
        r = normalize_report({"overall": "PASS", "findings": [{"summary": "x", "severity": "LOW"}]})
        self.assertEqual(r["overall"], "FAIL")

    def test_no_findings_is_pass_even_when_agent_says_fail(self):
        self.assertEqual(normalize_report({"overall": "FAIL", "findings": []})["overall"], "PASS")

    def test_unknown_sentinel_survives(self):
        self.assertEqual(normalize_report({"overall": "UNKNOWN", "findings": []})["overall"], "UNKNOWN")

    def test_non_dict_findings_are_kept_as_findings_not_dropped(self):
        r = normalize_report({"overall": "FAIL", "findings": ["login broken", 5]})
        self.assertEqual(len(r["findings"]), 2)
        self.assertEqual(r["overall"], "FAIL")  # review: dropping them turned this exact report into PASS

    def test_extract_json_prefers_the_structured_report_over_a_trailing_bare_object(self):
        text = 'Report: ```json\n{"overall":"FAIL","findings":[{"summary":"x"}],"pages_tested":3}\n``` page said {"findings": []}'
        self.assertEqual(extract_json(text)["pages_tested"], 3)


DIFF_ONE = "--- a/frontend/src/pages/X.tsx\n+++ b/frontend/src/pages/X.tsx\n@@ -1 +1 @@\n-a\n+b\n"
DIFF_TWO = DIFF_ONE + "--- a/.github/scripts/redact.js\n+++ b/.github/scripts/redact.js\n@@ -1 +1 @@\n-x\n+y\n"


class DiffConfinementTest(unittest.TestCase):
    def test_paths_from_both_headers(self):
        self.assertEqual(diff_paths(DIFF_TWO), {"frontend/src/pages/X.tsx", ".github/scripts/redact.js"})
        self.assertEqual(diff_paths("--- /dev/null\n+++ b/new.ts\n"), {"new.ts"})

    def test_single_file_diff_for_the_asked_file_is_confined(self):
        self.assertEqual(diff_is_confined(DIFF_ONE, "frontend/src/pages/X.tsx"), (True, ""))

    def test_multi_file_diff_is_refused(self):
        ok, why = diff_is_confined(DIFF_TWO, "frontend/src/pages/X.tsx")
        self.assertFalse(ok)
        self.assertIn("redact.js", why)

    def test_diff_for_a_different_file_is_refused(self):
        ok, _ = diff_is_confined(DIFF_ONE, "frontend/src/pages/Y.tsx")
        self.assertFalse(ok)

    def test_protected_paths_are_refused_even_when_asked(self):
        for rel in (".github/workflows/ci.yml", "infra/lib/stacks/api-stack.ts", ".sdlc/active",
                    "ci-agent/qa_agent.py", "intent/x/plan.md", "frontend/../infra/x.ts"):
            self.assertFalse(diff_is_confined(f"--- a/{rel}\n+++ b/{rel}\n", rel)[0], rel)

    def test_non_content_edits_are_refused(self):
        rel = "frontend/src/pages/X.tsx"
        for bad in ("deleted file mode 100644", "new file mode 120000", "old mode 100644", "GIT binary patch", "+++ /dev/null"):
            d = f"--- a/{rel}\n+++ b/{rel}\n{bad}\n@@ -1 +1 @@\n-a\n+b\n"
            self.assertFalse(diff_is_confined(d, rel)[0], bad)

    def test_extract_diff_then_confine(self):
        text = "```diff\n" + DIFF_TWO + "```\nanalysis"
        self.assertFalse(diff_is_confined(extract_diff(text), "frontend/src/pages/X.tsx")[0])


if __name__ == "__main__":
    unittest.main()
