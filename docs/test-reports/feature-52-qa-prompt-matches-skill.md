# Feature 52 — QA prompt matches the skill: AWS calls from `shell`, and a login step the agent can follow

- **Chain:** `intent/qa-prompt-matches-skill/` · **Branch:** `fix/qa-prompt-matches-skill` off `main@b774f3f` (post-#130) · **Issue:** #131 · **PR:** #132
- **Origin:** the narrowed-tools check of the UI harness (Harness repo #80 / #81), 2026-11-27/28
- **Date:** 2026-11-28
- **Verdict:** PASS — unit checks, and one live run in which no pass called the code interpreter before `shell`.

## What this report has to say plainly
- **The prompt told the agent to use a tool that cannot do the job.** STEP 0 (read the login secret) and STEP 3 (upload
  the artifacts) both named the code interpreter. The AWS-managed code interpreter has no AWS credentials; `shell` runs
  in the harness runtime with the execution role. The ui-testing skill (Harness repo) already said `shell`. In every
  pass with a span record, the agent followed the prompt first and the skill second:

  | Run | Pass | First tools after `skills` (span order) |
  |---|---|---|
  | 2026-11-27 16:00Z, throwaway harness (TUMS `2928e2a`) | viewer, admin | code_interpreter → shell |
  | 2026-11-28 00:39Z, live v9 (TUMS `b774f3f`) | viewer, admin | code_interpreter → shell |

  Spans do not record tool payloads. The credential error itself is in the agent's reply ("the code interpreter had no
  AWS credentials, so I read the secret from the shell instead") and in the invocation log.
- **One rule in STEP 0 could not be kept.** "Never print the password … keep email/password in variables" assumed the
  secret read and the typing happen in one process. They don't: the browser's `type` action types text the model writes.
  So the agent improvised. One pass: "I had to print the password there to type it into the sign-in form. It appears in
  the tool output but not in my reply." Another: "removed the temporary credentials file afterwards". The prompt now
  says what the skill says: the password passes through the context once and is repeated nowhere else.
- **This does not keep the password out of the model's context.** It still enters the context, and so the invocation
  log and the session's Memory events. A token handoff would remove it; that is a separate design change.

## Changes
| File | Change |
|---|---|
| `ci-agent/qa_agent.py` | `LOGIN_STEPS` STEP 0: boto3 from `shell`, printing url / email / password; the code interpreter has no AWS credentials; the password passes through the context once and is repeated nowhere else. `REPORT_STEPS` STEP 3: write and upload from `shell` with boto3 |
| `ci-agent/test_agents.py` | `test_prompts_send_aws_calls_through_shell_not_the_code_interpreter` (44 tests) |

## Unit checks (boto3 stubbed)
| Check | Result |
|---|---|
| `python3 -m unittest test_agents` on Python 3.12 and 3.14 | 44 / 44 PASS |
| New test against each half reverted (old STEP 0; old STEP 3; the old "never echo" rule) | 3 / 3 fail the new test |
| PR #122's 24 mutants, PR #130's 12 mutants | 24 / 24 and 12 / 12 still killed, none skipped |
| SDLC gate against `main@b774f3f` with `--base-sha` | PASS (`SDLC CI GATE PASSED`; 2 source files, both named in the plan) |

## Live verification
**One `qa_agent.py` run of this prompt (local copy, blob `3acbd1f`), 2026-11-28 01:35:37–01:41:55Z, against the live
UI harness v9.** It used the slot the coordinating session gave, with nothing else on the harness (last other span:
01:07:00Z). The QA passwords were rotated after it.

| Check | Viewer | Admin |
|---|---|---|
| Tools offered (`gen_ai.agent.tools`) | shell, read, browser, code_interpreter, retrieve_context, skills | same |
| Order of the first tools (`execute_tool` spans) | skills → **shell** → browser … | skills → **shell** → browser |
| code_interpreter before `shell` | ✅ none (3 calls, at positions 31, 32, 56, mid-exploration) | ✅ none (0 calls) |
| Sign-in, pages | ✅ signed in, `pages_tested` 10 | ✅ signed in, `/settings` read |
| `persona_check`, `readonly` | ✅ ok, ok (0 violations) | ✅ ok, ok (one click = Sign in) |
| S3 artifacts | ✅ uploaded from `shell` (last call) | ✅ uploaded from `shell` (last call) |

Before this change, both earlier runs went skills → **code_interpreter** → shell in every pass. This run's 7 findings
describe the app, not the prompt; they are left to the app's own issues.

Cost: about $0.84 at Sonnet 5.5 list price ($0.74 viewer + $0.11 admin).

## Still open
- Per-run QA passwords inside a run lock (proposed next). The password still passes through the model's context, but
  it would be valid only for its run, so no manual rotation would be needed. For this dev-only platform the owner
  chose that over a token handoff.
- Whether Memory events of earlier runs hold a password. Any check must compare against the current values as a
  boolean, never display them.
