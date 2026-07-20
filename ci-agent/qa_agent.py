#!/usr/bin/env python3
"""
UI QA Agent orchestrator — the "UI Test Agent" stage of the CI/CD loop.

Invokes the AgentCore UITestAgentHarness on the data plane. The agent logs into the
target site (credentials read from Secrets Manager, never passed on the command line),
explores every page, captures screenshots, and returns a structured PASS/FAIL report.
Findings are written to qa-report.json for the downstream Bug-Fix stage and PR comment.

Usage:
    python qa_agent.py --harness-arn <ARN> --url https://... [--secret-id <name>] [--out qa-report.json]

Env / defaults suit the Token Monitoring demo; override with flags for other targets.
"""
import argparse
import json
import os
import re
import secrets
import sys

import boto3
from botocore.config import Config as BotoConfig

REGION = os.environ.get("AWS_REGION", "us-east-1")


def _account_id() -> str:
    """Account ID from AWS_ACCOUNT_ID env, else resolved live via STS (never hard-coded)."""
    acct = os.environ.get("AWS_ACCOUNT_ID")
    if acct:
        return acct
    return boto3.client("sts", region_name=REGION).get_caller_identity()["Account"]


ACCOUNT_ID = _account_id()
UI_HARNESS = os.environ.get("UI_HARNESS", "UITestAgentHarness")
DEFAULT_HARNESS = f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT_ID}:harness/{UI_HARNESS}"
DEFAULT_BUCKET = os.environ.get("QA_BUCKET", f"token-monitor-qa-reports-{ACCOUNT_ID}")
DEFAULT_SECRET = "token-monitor-demo/login-creds"

PROMPT_TEMPLATE = r"""You are a QA test agent performing real exploratory testing of a React SPA.

STEP 0 — Credentials (never print the password):
Use the code interpreter to read login creds from AWS Secrets Manager:
    import boto3, json
    s = boto3.client("secretsmanager", region_name="{region}")
    c = json.loads(s.get_secret_value(SecretId="{secret_id}")["SecretString"])
    print(c["url"])   # print URL only
Keep email/password in variables; never echo the password.

STEP 1 — Login:
Use the browser tool. Navigate to the URL, wait for the SPA to render the sign-in form
(inputs 'email','password'; button 'Sign in'). Type the email and password, click Sign in,
wait for the app shell (sidebar nav) to appear, screenshot. If login fails, quote the exact
error and STOP with that report.

STEP 2 — Explore every page reachable from the sidebar nav. For each page:
  - navigate, wait for content (spinner gone), screenshot
  - record: loaded OK? any "Failed to load" banner? empty/⚠️ state? console errors? failed
    network requests (non-200)? KPIs blank/NaN? charts/tables rendered or empty?
  - cross-check values that should agree across pages; flag inconsistencies.
  - interact where sensible (hover chart, click table header, toggle controls).

STEP 3 — Save artifacts with the code interpreter:
  - write /mnt/reports/test-report-latest.json and /mnt/reports/summary.md
  - upload everything under /mnt/reports (incl. screenshots/) to
    s3://{bucket}/{run_prefix}/ preserving relative paths.

STEP 4 — Final answer (CRITICAL — do this even if you run low on time/steps):
You MUST end your reply with a single fenced ```json block containing ONLY this object:
{{"overall": "PASS"|"FAIL", "pages_tested": <int>, "findings": [
   {{"id": "...", "page": "...", "severity": "CRITICAL"|"HIGH"|"MEDIUM"|"LOW",
     "summary": "...", "evidence": "...", "suspected_source": "path or area if inferable"}}
]}}
Rules for the final JSON:
- Every inconsistency, discrepancy, wrong value, missing data, or broken control you noticed
  during exploration MUST appear as a findings entry — do NOT report "0 findings" if you
  described any problem above. A cross-page value mismatch is at least HIGH.
- If you are running out of steps, STOP exploring and emit the JSON now with what you have.
- overall = "FAIL" if findings is non-empty, else "PASS". Never leave it blank.
This is REAL testing — report the true state, never invent passes."""


def stream_text(resp) -> str:
    out = []
    for event in resp["stream"]:
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"].get("delta", {})
            if "text" in delta:
                out.append(delta["text"])
    return "".join(out)


def safe_stream(resp) -> str:
    """Like stream_text, but if the stream drops (read timeout, connection reset) partway,
    return whatever text arrived so far instead of raising — a long UI run can outlast the
    socket, and a partial transcript is still worth salvaging findings from."""
    out = []
    try:
        for event in resp["stream"]:
            if "contentBlockDelta" in event:
                delta = event["contentBlockDelta"].get("delta", {})
                if "text" in delta:
                    out.append(delta["text"])
    except Exception as e:  # botocore/urllib3 read timeout, connection reset, etc.
        print(f"\n⚠️  stream interrupted ({type(e).__name__}: {e}); using partial transcript.",
              file=sys.stderr)
    return "".join(out)


def salvage_findings(text: str) -> list:
    """Last-resort recovery: the agent narrated problems but never emitted the STEP 4 JSON.
    Pull sentences that clearly flag an issue into coarse findings so the run reports something
    actionable rather than a false '0 findings'. Heuristic and intentionally conservative."""
    markers = re.compile(
        r"(discrepan|inconsist|mismatch|does not match|doesn't match|should (?:agree|match|equal)"
        r"|missing|duplicate|\$0\.00|NaN|contradict|confusing|ambiguous|wrong|broken|fails?\b"
        r"|critical finding|major finding|found it)", re.I)
    seen, findings = set(), []
    for raw in re.split(r"(?<=[.!?])\s+|\n+", text):
        s = raw.strip()
        if len(s) < 25 or not markers.search(s):
            continue
        key = s[:80].lower()
        if key in seen:
            continue
        seen.add(key)
        sev = "HIGH" if re.search(r"critical|major|\$0\.00|missing|discrepan|mismatch", s, re.I) else "MEDIUM"
        findings.append({
            "id": f"salvaged-{len(findings) + 1}",
            "page": "unknown",
            "severity": sev,
            "summary": s[:300],
            "evidence": s[:1000],
            "suspected_source": "",
        })
        if len(findings) >= 15:
            break
    return findings


def extract_json(text: str):
    """Pull the last JSON object out of the agent's reply (it may wrap it in prose/fences)."""
    fenced = re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    candidates = fenced + re.findall(r"(\{(?:[^{}]|\{[^{}]*\})*\})", text, re.DOTALL)
    for c in reversed(candidates):
        try:
            obj = json.loads(c)
            if "findings" in obj or "overall" in obj:
                return obj
        except json.JSONDecodeError:
            continue
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Run the UI QA agent stage")
    ap.add_argument("--harness-arn", default=DEFAULT_HARNESS)
    ap.add_argument("--url", required=True)
    ap.add_argument("--secret-id", default=DEFAULT_SECRET)
    ap.add_argument("--region", default=REGION)
    ap.add_argument("--bucket", default=DEFAULT_BUCKET)
    ap.add_argument("--run-prefix", default="run-latest")
    ap.add_argument("--out", default="qa-report.json")
    ap.add_argument("--session-id", default=None)
    args = ap.parse_args()

    session_id = args.session_id or f"qa-ci-{secrets.token_hex(16)}"
    prompt = PROMPT_TEMPLATE.format(
        region=args.region, secret_id=args.secret_id, url=args.url,
        bucket=args.bucket, run_prefix=args.run_prefix,
    )
    # The URL is injected via the secret; also state it plainly so the agent has it up front.
    prompt = f"Target URL: {args.url}\n\n" + prompt

    # A UI-exploration run streams for many minutes; botocore's default 60s read timeout would
    # abort mid-stream. Give the socket a long read window and don't let botocore auto-retry a
    # long-running invoke (that would restart the whole exploration).
    cfg = BotoConfig(read_timeout=900, connect_timeout=30, retries={"max_attempts": 0})
    client = boto3.client("bedrock-agentcore", region_name=args.region, config=cfg)
    print(f"🧪 UI QA Agent — session {session_id}\n   target {args.url}", flush=True)
    resp = client.invoke_harness(
        harnessArn=args.harness_arn, runtimeSessionId=session_id,
        actorId="ci-pipeline",
        messages=[{"role": "user", "content": [{"text": prompt}]}],
    )
    text = safe_stream(resp)
    print(text)

    report = extract_json(text)
    # The exploratory reply often ends in prose, not clean JSON. Ask once more, in the SAME
    # session (so the agent still has its findings in context), for the JSON object only.
    if not report or not report.get("findings"):
        followup = (
            "Now output ONLY the JSON object described in STEP 4 — no prose, no code fence, "
            "nothing before or after it. Include EVERY issue you observed during the run "
            "(data discrepancies, missing rows, wrong input types, cross-page mismatches, etc.) "
            "as a finding with a severity. If you truly saw no issues, return an empty findings array."
        )
        try:
            resp2 = client.invoke_harness(
                harnessArn=args.harness_arn, runtimeSessionId=session_id, actorId="ci-pipeline",
                messages=[{"role": "user", "content": [{"text": followup}]}],
            )
            text2 = safe_stream(resp2)
            print("\n--- structured-output pass ---\n" + text2)
            report = extract_json(text2) or report
        except Exception as e:
            # Never let the structured-output pass crash the stage — fall back to salvaging
            # findings from the exploration transcript we already have.
            print(f"\n⚠️  structured-output pass failed ({e}); salvaging from transcript.", file=sys.stderr)
    if not report or not report.get("findings"):
        salvaged = salvage_findings(text)
        if salvaged:
            report = {"overall": "FAIL", "pages_tested": None, "findings": salvaged,
                      "note": "findings salvaged from exploration transcript"}
    report = report or {"overall": "UNKNOWN", "findings": [], "raw": text[-4000:]}
    with open(args.out, "w") as f:
        json.dump(report, f, indent=2)

    findings = report.get("findings", [])
    print(f"\n— {len(findings)} finding(s); overall={report.get('overall')} — wrote {args.out}")
    # Non-zero exit if any real finding, so CI marks the check failed and the loop continues.
    blocking = [f for f in findings if f.get("severity") in ("CRITICAL", "HIGH", "MEDIUM")]
    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main())
