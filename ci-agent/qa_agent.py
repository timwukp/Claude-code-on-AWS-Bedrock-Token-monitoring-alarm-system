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

STEP 4 — Final answer: return ONLY a JSON object (no prose around it) of the form:
{{"overall": "PASS"|"FAIL", "pages_tested": <int>, "findings": [
   {{"id": "...", "page": "...", "severity": "CRITICAL"|"HIGH"|"MEDIUM"|"LOW",
     "summary": "...", "evidence": "...", "suspected_source": "path or area if inferable"}}
]}}
This is REAL testing — report the true state, never invent passes."""


def stream_text(resp) -> str:
    out = []
    for event in resp["stream"]:
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"].get("delta", {})
            if "text" in delta:
                out.append(delta["text"])
    return "".join(out)


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

    client = boto3.client("bedrock-agentcore", region_name=args.region)
    print(f"🧪 UI QA Agent — session {session_id}\n   target {args.url}", flush=True)
    resp = client.invoke_harness(
        harnessArn=args.harness_arn, runtimeSessionId=session_id,
        actorId="ci-pipeline",
        messages=[{"role": "user", "content": [{"text": prompt}]}],
    )
    text = stream_text(resp)
    print(text)

    report = extract_json(text) or {"overall": "UNKNOWN", "findings": [], "raw": text[-4000:]}
    with open(args.out, "w") as f:
        json.dump(report, f, indent=2)

    findings = report.get("findings", [])
    print(f"\n— {len(findings)} finding(s); overall={report.get('overall')} — wrote {args.out}")
    # Non-zero exit if any real finding, so CI marks the check failed and the loop continues.
    blocking = [f for f in findings if f.get("severity") in ("CRITICAL", "HIGH", "MEDIUM")]
    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main())
