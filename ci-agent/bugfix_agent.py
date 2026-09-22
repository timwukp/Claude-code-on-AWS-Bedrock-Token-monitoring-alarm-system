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


def active_plan(repo_root: str) -> tuple[str | None, str]:
    """The active chain's plan.md text, plus a label for it.

    Returns (None, label) when no active chain can be read, which makes the caller refuse to
    patch anything. Failing closed is deliberate: the sdlc gate rejects any changed source file
    the active plan does not name, so a patch outside the plan turns the very check the fix was
    meant to green into a red one. That happened on #48 (ProjectsPage) and #51 (dora.ts), each
    needing a hand-written revert commit."""
    try:
        with open(os.path.join(repo_root, ".sdlc", "active"), encoding="utf-8") as f:
            slug = f.read().strip().splitlines()[0].strip()
    except (OSError, IndexError):
        return None, "no .sdlc/active"
    if not slug:
        return None, "empty .sdlc/active"
    try:
        with open(os.path.join(repo_root, "intent", slug, "plan.md"),
                  encoding="utf-8") as f:
            return f.read().replace("\\", "/"), slug
    except OSError:
        return None, f"{slug} (no plan.md)"


def plan_covers(plan_text: str, rel: str) -> bool:
    """Mirror of sdlc_ci_gate.plan_covers — a plain substring test, deliberately.

    It must stay byte-identical in behaviour to the gate's own check. If this were stricter the
    bot would refuse patches the gate would accept; if looser, it would push patches the gate
    rejects, which is the failure this rule exists to prevent."""
    return rel.replace("\\", "/") in plan_text


def recurrence_note(finding: dict, report: dict) -> str:
    """Flag a finding that has been reported before, so it gets a chain instead of another round.

    A finding outside the active plan is refused every round, so it survives PR after PR without
    anyone owning it: the /anomalies window-button label was reported four times (F-PR51-006 →
    F-PR52-001 → F-PR53-003 → F-PR53-103) purely for want of plan coverage. Naming the recurrence
    in the summary is what turns it into an action."""
    fid = finding.get("id") or ""
    still = any(r.get("id") == fid and r.get("status") == "STILL_FAILING"
                for r in report.get("reconciliation") or [])
    # Findings cite their own ancestry in the evidence ("recurrence of F-PR51-006/F-PR52-001").
    earlier = sorted({i for i in re.findall(r"F-[A-Za-z0-9-]+",
                                            finding.get("evidence") or "") if i != fid})
    if not (still or earlier):
        return ""
    seen = f" as {', '.join(earlier)}" if earlier else ""
    return (f" **This is a repeat report**{seen} — it needs its own intent chain naming that file, "
            f"because waiting for a plan that happens to cover it is why it keeps recurring.")


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
    # Fall back to keyword match. `suspected_source` is usually prose, not a path ("shared
    # currency formatting helper in frontend"), so it feeds the keywords too — scoring only
    # page+summary sends every /projects finding to projects.ts regardless of its subject.
    text = " ".join((finding.get("page", ""), finding.get("summary", ""), hint)).lower()
    words = set(re.findall(r"[a-z]{4,}", text))
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
    """Pull the first unified diff out of the agent's reply.

    Handles a fence the model never closed. A max-token stop truncates mid-reply, so the
    closing ``` never arrives — requiring it would discard an otherwise-complete diff and
    make stream_text's salvage path dead code for the one failure mode it exists for."""
    m = re.search(r"```(?:diff)?\s*(--- a/.*?)```", text, re.DOTALL)
    if m:
        return m.group(1).rstrip() + "\n"
    # Unterminated fence (truncated reply) — take everything from the first file header on.
    m = re.search(r"(?:```(?:diff)?\s*)?(--- a/.*)", text, re.DOTALL)
    if m:
        body = m.group(1).rstrip()
        # Drop a trailing partial hunk line the truncation cut mid-way: a unified diff line
        # must start with ' ', '+', '-', '@' or '\'. Anything else at the tail is debris.
        lines = body.split("\n")
        while lines and not (lines[-1][:1] in (" ", "+", "-", "@", "\\") or lines[-1] == ""):
            lines.pop()
        body = "\n".join(lines).rstrip()
        return body + "\n" if body.startswith("--- a/") else None
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
    ap.add_argument("--patched-list", default="bugfix-patched.txt",
                    help="Where to write the paths actually patched, one per line, so the "
                         "workflow can stage exactly those and nothing else.")
    args = ap.parse_args()

    with open(args.report) as f:
        report = json.load(f)
    findings = [f for f in report.get("findings", [])
                if f.get("severity") in ("CRITICAL", "HIGH", "MEDIUM")]
    if not findings:
        print("No blocking findings — nothing to fix.")
        open(args.out, "w").write("No blocking findings; no fix generated.\n")
        # Always leave the list behind, even empty: the workflow reads it unconditionally.
        open(args.patched_list, "w").write("")
        return 0

    # Root-causing + patching a finding can stream for many minutes (stronger models think
    # longer); botocore's default 60s read timeout kills the invoke mid-stream. Mirror the
    # long-read config qa_agent.py already uses, and don't auto-retry a long invoke.
    cfg = BotoConfig(read_timeout=900, connect_timeout=30, retries={"max_attempts": 0})
    client = boto3.client("bedrock-agentcore", region_name=args.region, config=cfg)
    plan_text, chain = active_plan(args.repo_root)
    if plan_text is None:
        print(f"⛔ no readable active plan ({chain}) — refusing to patch anything", file=sys.stderr)
    summaries, applied, patched = [], 0, []
    for finding in findings:
        src_path = guess_source(finding, args.repo_root)
        if not src_path:
            summaries.append(f"- **{finding.get('id')}** — could not locate source; skipped.")
            continue
        rel = os.path.relpath(src_path, args.repo_root)
        # Rule (b): the bot may only edit files the active intent plan names.
        if plan_text is None or not plan_covers(plan_text, rel):
            where = f"the active plan (`{chain}`)" if plan_text is not None else f"any plan ({chain})"
            summaries.append(
                f"- **{finding.get('id')}** — `{rel}` is not named in {where}, so it was **not "
                f"patched**.{recurrence_note(finding, report)}")
            print(f"⛔ {finding.get('id')}: {rel} not covered by {chain} — refused")
            continue
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
(use `--- a/{rel}` / `+++ b/{rel}` headers).

Output the ```diff block FIRST, then your analysis after it. (Order matters: if you are cut off by
a token limit, the diff must already be complete — analysis is the part that can be safely lost.)
If {rel} is the wrong file, or the fix is architectural rather than a local edit, say so in one
line and output NO diff instead of guessing."""
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
            patched.append(rel)
            summaries.append(f"- **{finding.get('id')}** ({finding.get('severity')}) → patched `{rel}`\n\n"
                             f"```diff\n{diff}```")
            print(f"✅ patched {rel} for {finding.get('id')}")
        else:
            summaries.append(f"- **{finding.get('id')}** — agent produced no applicable diff.")
            print(f"⚠️  no applicable diff for {finding.get('id')}")

    with open(args.out, "w") as f:
        f.write(f"## Bug-Fix Agent — {applied}/{len(findings)} finding(s) patched\n\n")
        if plan_text is not None:
            f.write(f"Scope: only files named in `intent/{chain}/plan.md` may be edited.\n\n")
        f.write("\n\n".join(summaries) + "\n")
    # Exact paths patched, so the workflow stages these and not a whole directory: a dir-scoped
    # `git add` would also sweep up anything else that happened to be dirty in the runner tree.
    with open(args.patched_list, "w") as f:
        f.write("".join(f"{p}\n" for p in patched))
    print(f"\n— applied {applied}/{len(findings)} fixes; wrote {args.out} "
          f"and {len(patched)} path(s) to {args.patched_list}")
    # "Nothing applicable to patch" is a RESULT, not a tool failure. Exiting non-zero here runs
    # under `bash -e` in the workflow, so it aborted the step before its own `git add` / "produced
    # no applicable source patch" branch — making that branch dead code — and before the Comment
    # on PR, stall-detector and fuse steps that own the red verdict and the actionable message.
    # Redness for an unclean report is now the "Fail check if the QA report is not clean" step's
    # job, which reads qa_agent's `overall` output; reserve a non-zero exit here for a genuine
    # failure of this tool. Returning 0 is what lets a refusal above be reported rather than crash.
    return 0


if __name__ == "__main__":
    sys.exit(main())
