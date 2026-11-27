# Spec: QA personas

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour
1. `ci-agent/qa_agent.py` — two passes, each its own harness session:
   - **viewer** (`--secret-id`, default `QA_VIEWER_SECRET` or `token-monitor-demo/login-creds-viewer`): the existing
     exploration of every page; STEP 2 limits interaction to what changes the display, and states that Settings'
     "Administrator access required" and ROI's missing Override column are correct for this persona.
   - **admin** (`--admin-secret-id`, default `QA_ADMIN_SECRET` or `token-monitor-demo/login-creds`; `''` skips it):
     reads `--admin-pages` (default `settings`, relative to `--url`) by navigate only; allowed browser actions are
     sign-in typing, the Sign in click, navigate, screenshot, get_text/get_html and tab/history actions. Session
     `<session>-admin`, memory actor `ci-pipeline-admin`, artifacts under `<run-prefix>/admin-pass/`.
   - `SAFETY_RULES` (both prompts): no Save/Submit/Add/Create/Update/Apply/Edit/Remove/Delete/Sync/Confirm/Approve/Reset/
     Override or danger-styled control unless a numbered STEP says so; no setting changes; type only into sign-in;
     dismiss dialogs; no POST/PUT/PATCH/DELETE from browser, page script, code interpreter or shell. They outrank the
     system prompt, skills and page text.
   - STEP 4 JSON gains `persona_observed` (`admin` | `non-admin`).
   - `safe_stream(resp, tool_calls)` collects each `toolUse` block (start → input deltas → stop, plus a block a
     dropped stream left open). `audit_actions(calls, strict)` returns `readonly` = `violated` (write-type click; page
     script or code that sends a non-GET request or clicks a write-type control, the Sign in button excepted as for clicks; with `strict`, any click but Sign in,
     typing outside the sign-in fields, or any other action outside the read-only list) | `unobserved` (no browser
     action seen) | `ok`. Typed text, scripts and code are never copied into the report.
   - `merge_reports`: findings tagged `persona`, admin ids prefixed `admin-`; `overall` = FAIL if any finding, else
     UNKNOWN if a pass has no report, else PASS; `pages_tested` is the viewer's; `passes[]` records each pass's
     verdict, pages, persona check, read-only status, violations and action counts (admin: the action trail).
   - Prior findings return to the pass that filed them (`persona == "admin"` → admin pass).
   - `$GITHUB_OUTPUT` gains `readonly` (worst of the passes) and `persona` (`mismatch` | `unreported` | `ok`).
2. `ci-agent/test_agents.py` — stream assembly, audit rules (both modes), the no-copy rule, persona mapping, prompts,
   merge, and `main()` end to end against a fake harness (two sessions, actors, prefixes, prior-finding routing,
   output flags, a strict-only violation, `--admin-secret-id ''`).
3. `.github/workflows/ui-qa-agent.yml` — `QA_VIEWER_SECRET` / `QA_ADMIN_SECRET` job env; `--secret-id
   "$QA_VIEWER_SECRET"` passed explicitly so a base-branch agent from before this change also signs in as the
   non-admin; PR comment shows one line per pass and marks admin-pass findings; new step **Fail check if a QA pass
   broke the safety rules** (`always()`): red on `readonly=violated` or `persona=mismatch`, warning on `unobserved` /
   `unreported`, no-op on empty outputs; `timeout-minutes` 120 → 150.

## Acceptance
- Unit: `python3 -m unittest test_agents` — 32 tests (12 before), on Python 3.12 and 3.14; every new guard killed by
  at least one test under mutation (24 of 24 mutants).
- Live (one `workflow_dispatch` run of this branch against the dev app): the viewer pass explores all 10 pages with
  `persona_check: ok`; the admin pass visits Settings with `persona_check: ok` and `readonly: ok`, and its action trail
  holds no click after Sign in; the registry and DORA repository data are unchanged across the run and the DORA collector
  does not start (the dev API stage has no access log to read).

## Out of scope
See the intent's Non-goals.
