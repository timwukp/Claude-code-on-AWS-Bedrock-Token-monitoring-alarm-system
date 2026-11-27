"""Stdlib-only tests for the pure parts of the CI agents (run: python3 -m unittest test_agents).
boto3/botocore are stubbed so the modules import without the SDK installed."""
import contextlib
import io
import json
import os
import sys
import types
import unittest

os.environ.setdefault("AWS_ACCOUNT_ID", "111122223333")  # synthetic; stops the modules calling STS at import

for name in ("boto3", "botocore", "botocore.config"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["botocore.config"].Config = object  # type: ignore[attr-defined]
sys.modules["boto3"].client = lambda *a, **k: None  # type: ignore[attr-defined]

from qa_agent import (  # noqa: E402
    audit_actions, build_prompt, extract_json, merge_reports, normalize_report, persona_check, safe_stream,
)
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


def browser(kind, **fields):
    return {"tool": "browser", "input": {"browser_input": {"action": {"type": kind, **fields}}}}


ADMIN_LOGIN = [browser("init_session", session_name="qa-admin-pass"),
               browser("navigate", url="https://app.example/"),
               browser("type", selector="input[name='email']", text="admin@example.test"),
               browser("type", selector="input[name='password']", text="hunter2-secret"),
               browser("click", selector="button:has-text('Sign in')")]
ADMIN_READ = [browser("navigate", url="https://app.example/settings"), browser("screenshot", path="s.png"),
              browser("get_text", selector="main")]


class StreamToolCallTest(unittest.TestCase):
    def test_tool_uses_are_assembled_from_start_delta_stop(self):
        events = [
            {"contentBlockStart": {"contentBlockIndex": 1, "start": {"toolUse": {"toolUseId": "t", "name": "browser"}}}},
            {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"toolUse": {"input": '{"browser_input": {"action": '}}}},
            {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"toolUse": {"input": '{"type": "click", "selector": "#x"}}}'}}}},
            {"contentBlockStop": {"contentBlockIndex": 1}},
            {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "done"}}},
        ]
        calls = []
        self.assertEqual(safe_stream({"stream": iter(events)}, calls), "done")
        self.assertEqual(calls, [{"tool": "browser", "input": {"browser_input": {"action": {"type": "click", "selector": "#x"}}}}])

    def test_a_block_cut_off_by_a_dropped_stream_is_still_audited(self):
        def stream():
            yield {"contentBlockStart": {"contentBlockIndex": 0, "start": {"toolUse": {"name": "browser"}}}}
            yield {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"toolUse": {"input": '{"browser_input"'}}}}
            raise TimeoutError("read timeout")
        calls = []
        safe_stream({"stream": stream()}, calls)
        self.assertEqual(len(calls), 1)

    def test_text_only_callers_are_unchanged(self):
        events = [{"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "a"}}},
                  {"contentBlockStop": {"contentBlockIndex": 0}}]
        self.assertEqual(safe_stream({"stream": iter(events)}), "a")


class ReadOnlyAuditTest(unittest.TestCase):
    def test_viewer_write_click_is_a_violation_and_a_sort_click_is_not(self):
        ok = audit_actions(ADMIN_LOGIN + [browser("click", selector="th button.th-sort")], strict=False)
        self.assertEqual(ok["readonly"], "ok")
        bad = audit_actions(ADMIN_LOGIN + [browser("click", selector="button:has-text('Save project')")], strict=False)
        self.assertEqual(bad["readonly"], "violated")
        self.assertEqual(audit_actions([browser("click", selector="button.btn-sm.danger")], strict=False)["readonly"],
                         "violated")

    def test_non_get_requests_from_page_script_code_or_shell_are_violations(self):
        for call in (browser("evaluate", script="fetch('/v1/dora/repos', {method: 'POST', body: '{}'})"),
                     browser("evaluate", script='fetch(u, {"method": "DELETE"})'),
                     browser("evaluate", script="const x = new XMLHttpRequest(); x.open('PUT', u); x.send()"),
                     browser("evaluate", script="[...document.querySelectorAll('button')].find(b => /Remove/.test(b.textContent)).click()"),
                     {"tool": "shell", "input": {"command": "curl -s -X DELETE https://api.example/v1/projects/registry/p1"}},
                     {"tool": "code_interpreter", "input": {"code_interpreter_input": {"action": {
                         "type": "executeCode", "code": "import requests\nrequests.post(u, json={})"}}}}):
            self.assertEqual(audit_actions([browser("navigate", url="u")] + [call], strict=False)["readonly"],
                             "violated", call)

    def test_a_scripted_sign_in_click_is_not_a_write(self):
        # Verbatim from the first live run (dispatch 46007195822), where it was a false violation.
        signin = ("window.__bs=[];const b=document.querySelector('button[type=submit]');new MutationObserver(()=>"
                  "window.__bs.push(b.disabled+':'+b.innerText)).observe(b,{attributes:true,childList:true,"
                  "characterData:true,subtree:true});b.click();'clicked'")
        self.assertEqual(audit_actions([browser("evaluate", script=signin)], strict=False)["readonly"], "ok")
        both = "document.querySelector('button[type=submit]'); [...document.querySelectorAll('button')].find(b => b.innerText === 'Save project').click()"
        self.assertEqual(audit_actions([browser("evaluate", script=both)], strict=False)["readonly"], "violated")
        self.assertEqual(audit_actions(ADMIN_LOGIN + [browser("evaluate", script=signin)], strict=True)["readonly"],
                         "violated")  # the admin pass may not run scripts at all

    def test_reading_and_uploading_artifacts_is_not_a_violation(self):
        calls = [browser("navigate", url="u"),
                 browser("evaluate", script="document.querySelector('main').innerText"),
                 browser("evaluate", script="fetch('/v1/costs', {method: 'GET'}).then(r => r.status)"),
                 browser("click", selector="button:has-text('Assumptions…')"),
                 browser("click", selector="button:has-text('Estimate')"),
                 {"tool": "code_interpreter", "input": {"code_interpreter_input": {"action": {
                     "type": "executeCode", "code": "s3.upload_file(p, bucket, key); s3.put_object(Bucket=b, Key=k)"}}}}]
        self.assertEqual(audit_actions(calls, strict=False)["readonly"], "ok")

    def test_admin_pass_may_sign_in_and_read_only(self):
        a = audit_actions(ADMIN_LOGIN + ADMIN_READ, strict=True)
        self.assertEqual((a["readonly"], a["violations"]), ("ok", []))

    def test_admin_pass_any_other_click_type_key_or_script_is_a_violation(self):
        for call in (browser("click", selector="a[href='/settings']"),
                     browser("type", selector="input[aria-label='Repository to add']", text="o/r"),
                     browser("press_key", key="Enter"),
                     browser("evaluate", script="document.title")):
            a = audit_actions(ADMIN_LOGIN + ADMIN_READ + [call], strict=True)
            self.assertEqual(a["readonly"], "violated", call)

    def test_a_pass_with_no_browser_action_is_unobserved_not_ok(self):
        self.assertEqual(audit_actions([], strict=True)["readonly"], "unobserved")
        self.assertEqual(audit_actions([{"tool": "code_interpreter", "input": {}}], strict=False)["readonly"], "unobserved")

    def test_typed_text_and_scripts_never_leave_the_audit(self):
        calls = ADMIN_LOGIN + [browser("evaluate", script="el.value='hunter2-secret'"),
                               browser("evaluate", script="fetch(u, {method: 'POST', body: 'hunter2-secret'})")]
        for strict in (True, False):
            self.assertNotIn("hunter2-secret", json.dumps(audit_actions(calls, strict=strict)))


class PersonaTest(unittest.TestCase):
    def test_persona_check(self):
        self.assertEqual(persona_check("non-admin", "Non-Admin"), "ok")
        self.assertEqual(persona_check("non-admin", "admin"), "mismatch")
        self.assertEqual(persona_check("admin", "non_admin"), "mismatch")
        self.assertEqual(persona_check("admin", None), "unreported")
        self.assertEqual(persona_check("admin", "unknown"), "unreported")
        self.assertEqual(persona_check("non-admin", "viewer"), "ok")
        self.assertEqual(persona_check("non-admin", "nonadmin"), "ok")
        self.assertEqual(persona_check("admin", "Administrator"), "ok")

    def test_prompts_carry_the_safety_rules_and_their_persona(self):
        kw = dict(region="us-east-1", secret_id="s", bucket="b", run_prefix="pr-1")
        viewer = build_prompt("viewer", **kw)
        admin = build_prompt("admin", admin_pages=["https://app.example/settings"], **kw)
        for p in (viewer, admin):
            self.assertIn("SAFETY RULES", p)
            self.assertIn("Never click a control that saves, submits, deletes", p)
            self.assertIn('"persona_observed"', p)
            self.assertIn('SecretId="s"', p)
        self.assertIn("NON-ADMIN", viewer)
        self.assertNotIn("interact where sensible", viewer)
        self.assertIn("  - https://app.example/settings", admin)
        self.assertIn("READ-ONLY ADMIN CHECK", admin)
        self.assertNotIn("Explore every page", admin)


def a_pass(persona, report, readonly="ok"):
    return {"persona": persona, "persona_expected": "admin" if persona == "admin" else "non-admin",
            "session_id": f"sid-{persona}", "report": normalize_report(report),
            "audit": {"readonly": readonly, "violations": [], "actions": {}, "trail": None}}


class MergeReportsTest(unittest.TestCase):
    def test_findings_are_tagged_and_admin_ids_cannot_collide(self):
        m = merge_reports([a_pass("viewer", {"pages_tested": 10, "persona_observed": "non-admin",
                                             "findings": [{"id": "F-01", "summary": "x"}]}),
                           a_pass("admin", {"pages_tested": 1, "persona_observed": "admin",
                                            "findings": [{"id": "F-01", "summary": "y"}]})])
        self.assertEqual([(f["id"], f["persona"]) for f in m["findings"]], [("F-01", "viewer"), ("admin-F-01", "admin")])
        self.assertEqual((m["overall"], m["pages_tested"]), ("FAIL", 10))
        self.assertEqual([p["persona_check"] for p in m["passes"]], ["ok", "ok"])

    def test_a_pass_without_a_report_withholds_pass(self):
        m = merge_reports([a_pass("viewer", {"pages_tested": 10, "findings": []}),
                           a_pass("admin", {"overall": "UNKNOWN", "findings": [], "raw": "r"})])
        self.assertEqual(m["overall"], "UNKNOWN")
        self.assertEqual(m["raw"], "r")

    def test_clean_passes_merge_to_pass(self):
        m = merge_reports([a_pass("viewer", {"pages_tested": 10, "findings": []}),
                           a_pass("admin", {"pages_tested": 1, "findings": []})])
        self.assertEqual(m["overall"], "PASS")


def tool_events(*calls):
    """Harness stream events for these tool calls, the way invoke_harness delivers them."""
    for i, c in enumerate(calls, start=1):
        yield {"contentBlockStart": {"contentBlockIndex": i, "start": {"toolUse": {"name": c["tool"]}}}}
        yield {"contentBlockDelta": {"contentBlockIndex": i, "delta": {"toolUse": {"input": json.dumps(c["input"])}}}}
        yield {"contentBlockStop": {"contentBlockIndex": i}}


class FakeHarness:
    """Stands in for boto3's bedrock-agentcore and s3 clients; records what main() asked for."""
    def __init__(self, admin_calls):
        self.invocations, self.admin_calls = [], admin_calls

    def invoke_harness(self, **kw):
        self.invocations.append(kw)
        admin = kw["runtimeSessionId"].endswith("-admin")
        calls = ADMIN_LOGIN + self.admin_calls if admin else ADMIN_LOGIN + [browser("click", selector="th button")]
        body = {"overall": "PASS", "pages_tested": 1 if admin else 10, "findings": [],
                "persona_observed": "admin" if admin else "non-admin"}
        text = "explored. " * 60 + "```json\n" + json.dumps(body) + "\n```"
        return {"stream": list(tool_events(*calls)) + [{"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": text}}}]}

    def upload_file(self, *a):
        pass


class MainTwoPassTest(unittest.TestCase):
    def run_main(self, admin_calls, extra=()):
        import qa_agent
        import tempfile
        fake = FakeHarness(admin_calls)
        d = tempfile.mkdtemp()
        prior = os.path.join(d, "prior.json")
        with open(prior, "w") as f:
            json.dump({"findings": [{"id": "F-01", "summary": "viewer thing", "severity": "LOW"},
                                    {"id": "admin-F-02", "summary": "admin thing", "severity": "LOW", "persona": "admin"}]}, f)
        out, gho = os.path.join(d, "r.json"), os.path.join(d, "gho")
        argv, client, cfg, env = sys.argv, qa_agent.boto3.client, qa_agent.BotoConfig, os.environ.get("GITHUB_OUTPUT")
        sys.argv = ["qa_agent.py", "--harness-arn", "arn", "--url", "https://app.example", "--out", out,
                    "--prior-report", prior, "--run-prefix", "pr-7", *extra]
        qa_agent.boto3.client, qa_agent.BotoConfig = (lambda *a, **k: fake), (lambda **k: None)
        os.environ["GITHUB_OUTPUT"] = gho
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                qa_agent.main()
        finally:
            sys.argv, qa_agent.boto3.client, qa_agent.BotoConfig = argv, client, cfg
            if env is None:
                os.environ.pop("GITHUB_OUTPUT", None)
            else:
                os.environ["GITHUB_OUTPUT"] = env
        with open(gho) as g, open(out) as r:
            return fake, json.load(r), dict(line.split("=", 1) for line in g.read().split())

    def test_two_sessions_two_personas_and_prior_findings_go_back_to_their_pass(self):
        fake, report, flags = self.run_main(ADMIN_READ)
        viewer, admin = fake.invocations
        self.assertEqual((viewer["actorId"], admin["actorId"]), ("ci-pipeline", "ci-pipeline-admin"))
        self.assertEqual(admin["runtimeSessionId"], viewer["runtimeSessionId"] + "-admin")
        vp, ap_ = (i["messages"][0]["content"][0]["text"] for i in (viewer, admin))
        self.assertIn('SecretId="token-monitor-demo/login-creds-viewer"', vp)
        self.assertIn('SecretId="token-monitor-demo/login-creds"', ap_)
        self.assertIn("  - https://app.example/settings", ap_)
        self.assertIn("s3://", ap_)
        self.assertIn("/pr-7/admin-pass/", ap_)
        self.assertIn("viewer thing", vp)
        self.assertNotIn("admin thing", vp)
        self.assertIn("admin thing", ap_)
        self.assertEqual((report["overall"], report["pages_tested"]), ("PASS", 10))
        self.assertEqual([p["persona"] for p in report["passes"]], ["viewer", "admin"])
        self.assertEqual({k: flags[k] for k in ("overall", "readonly", "persona")},
                         {"overall": "PASS", "readonly": "ok", "persona": "ok"})
        self.assertNotIn("hunter2-secret", json.dumps(report))

    def test_an_admin_click_on_remove_reddens_the_readonly_flag(self):
        _, report, flags = self.run_main(ADMIN_READ + [browser("click", selector="button.btn-sm.danger")])
        self.assertEqual(flags["readonly"], "violated")
        self.assertEqual(report["passes"][1]["readonly"], "violated")

    def test_the_admin_pass_is_held_to_its_stricter_list(self):
        # A sidebar click is fine for the viewer and a violation for the admin pass.
        _, report, flags = self.run_main(ADMIN_READ + [browser("click", selector="a[href='/settings']")])
        self.assertEqual((flags["readonly"], report["passes"][0]["readonly"]), ("violated", "ok"))

    def test_empty_admin_secret_skips_the_admin_pass(self):
        fake, report, _ = self.run_main(ADMIN_READ, extra=("--admin-secret-id", ""))
        self.assertEqual(len(fake.invocations), 1)
        self.assertEqual([p["persona"] for p in report["passes"]], ["viewer"])


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
