#!/usr/bin/env python3
"""
Bug-Fix Agent orchestrator — the "Bug-Fix Agent → PR" stage of the CI/CD loop.

Reads qa-report.json (from qa_agent.py), and for each blocking finding, asks the
AgentCore BugFixAgentHarness to root-cause it against the relevant repo source and
emit a minimal unified diff. Diffs are applied to the working tree; the caller
(the workflow) commits and opens/updates the PR.

Usage:
    python bugfix_agent.py --report qa-report.json [--harness-arn <ARN>] [--repo-root .]
"""
import argparse
import json
import os
import re
import secrets
import subprocess
import sys

import boto3
from botocore.config import Config as BotoConfig

REGION = os.environ.get("AWS_REGION", "us-east-1")
_ACCOUNT_ID = os.environ.get("AWS_ACCOUNT_ID") or \
    boto3.client("sts", region_name=REGION).get_caller_identity()["Account"]
BUGFIX_HARNESS = os.environ.get("BUGFIX_HARNESS", "BugFixAgentHarness")
DEFAULT_HARNESS = f"arn:aws:bedrock-agentcore:{REGION}:{_ACCOUNT_ID}:harness/{BUGFIX_HARNESS}"

# Where to look for source when a finding doesn't name a file. Keep small and repo-specific.
SEARCH_DIRS = ["backend/lambdas", "frontend/src"]


def stream_text(resp) -> str:
    """Collect streamed text; on a dropped/errored stream return what arrived so far.

    A stream error mid-fix (read timeout, runtimeClientError like max-token stops) must not
    crash the whole stage — that would discard patches already applied for earlier findings.
    The partial text often still contains a complete ```diff block worth applying."""
    out = []
    try:
        for event in resp["stream"]:
            if "contentBlockDelta" in event:
                delta = event["contentBlockDelta"].get("delta", {})
                if "text" in delta:
                    out.append(delta["text"])
    except Exception as e:
        print(f"⚠️  stream interrupted ({type(e).__name__}): {e} — salvaging partial output",
              file=sys.stderr)
    return "".join(out)


def guess_source(finding: dict, repo_root: str) -> str | None:
    """Return a path whose content is most relevant to the finding, or None."""
    hint = finding.get("suspected_source") or ""
    cand = os.path.join(repo_root, hint)
    if hint and os.path.isfile(cand):
        return cand
    # Fall back to keyword match on the page/summary against filenames.
    words = re.findall(r"[a-z]{4,}", (finding.get("page", "") + " " + finding.get("summary", "")).lower())
    best, best_score = None, 0
    for d in SEARCH_DIRS:
        base = os.path.join(repo_root, d)
        for root, _, files in os.walk(base):
            for fn in files:
                if not fn.endswith((".ts", ".tsx")):
                    continue
                score = sum(w in fn.lower() for w in words)
                if score > best_score:
                    best, best_score = os.path.join(root, fn), score
    return best


def extract_diff(text: str) -> str | None:
    m = re.search(r"```(?:diff)?\s*(--- a/.*?)```", text, re.DOTALL)
    if m:
        return m.group(1).rstrip() + "\n"
    if text.lstrip().startswith("--- a/"):
        return text.rstrip() + "\n"
    return None


def apply_patch(diff: str, repo_root: str) -> bool:
    proc = subprocess.run(["git", "apply", "--recount", "-p1", "-"],
                          input=diff, text=True, cwd=repo_root,
                          capture_output=True)
    if proc.returncode != 0:
        # Retry a touch more leniently.
        proc = subprocess.run(["git", "apply", "--recount", "--3way", "-p1", "-"],
                              input=diff, text=True, cwd=repo_root, capture_output=True)
    if proc.returncode != 0:
        print(f"   git apply failed: {proc.stderr.strip()}", file=sys.stderr)
        return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", default="qa-report.json")
    ap.add_argument("--harness-arn", default=DEFAULT_HARNESS)
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--repo-root", default=".")
    ap.add_argument("--out", default="bugfix-summary.md")
    args = ap.parse_args()

    with open(args.report) as f:
        report = json.load(f)
    findings = [f for f in report.get("findings", [])
                if f.get("severity") in ("CRITICAL", "HIGH", "MEDIUM")]
    if not findings:
        print("No blocking findings — nothing to fix.")
        open(args.out, "w").write("No blocking findings; no fix generated.\n")
        return 0

    # Root-causing + patching a finding can stream for many minutes (stronger models think
    # longer); botocore's default 60s read timeout kills the invoke mid-stream. Mirror the
    # long-read config qa_agent.py already uses, and don't auto-retry a long invoke.
    cfg = BotoConfig(read_timeout=900, connect_timeout=30, retries={"max_attempts": 0})
    client = boto3.client("bedrock-agentcore", region_name=args.region, config=cfg)
    summaries, applied = [], 0
    for finding in findings:
        src_path = guess_source(finding, args.repo_root)
        if not src_path:
            summaries.append(f"- **{finding.get('id')}** — could not locate source; skipped.")
            continue
        rel = os.path.relpath(src_path, args.repo_root)
        source = open(src_path).read()
        prompt = f"""A real bug was found by our UI Test Agent:

ID: {finding.get('id')}
Page: {finding.get('page')}
Severity: {finding.get('severity')}
Summary: {finding.get('summary')}
Evidence: {finding.get('evidence')}

Here is the source that most likely contains the bug ({rel}):

```
{source}
```

Root-cause it and output a MINIMAL unified diff that fixes it. The diff MUST apply against {rel}
(use `--- a/{rel}` / `+++ b/{rel}` headers). Output analysis, then the diff in a ```diff block."""
        try:
            resp = client.invoke_harness(
                harnessArn=args.harness_arn,
                runtimeSessionId=f"bugfix-ci-{secrets.token_hex(16)}",
                messages=[{"role": "user", "content": [{"text": prompt}]}],
            )
            text = stream_text(resp)
        except Exception as e:
            summaries.append(f"- **{finding.get('id')}** — invoke failed ({type(e).__name__}); skipped.")
            print(f"⚠️  invoke failed for {finding.get('id')}: {e}", file=sys.stderr)
            continue
        diff = extract_diff(text)
        if diff and apply_patch(diff, args.repo_root):
            applied += 1
            summaries.append(f"- **{finding.get('id')}** ({finding.get('severity')}) → patched `{rel}`\n\n"
                             f"```diff\n{diff}```")
            print(f"✅ patched {rel} for {finding.get('id')}")
        else:
            summaries.append(f"- **{finding.get('id')}** — agent produced no applicable diff.")
            print(f"⚠️  no applicable diff for {finding.get('id')}")

    with open(args.out, "w") as f:
        f.write(f"## Bug-Fix Agent — {applied}/{len(findings)} finding(s) patched\n\n")
        f.write("\n\n".join(summaries) + "\n")
    print(f"\n— applied {applied}/{len(findings)} fixes; wrote {args.out}")
    return 0 if applied else 2


if __name__ == "__main__":
    sys.exit(main())
