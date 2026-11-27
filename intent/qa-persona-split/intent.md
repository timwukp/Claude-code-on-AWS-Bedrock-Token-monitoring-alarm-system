# Intent: QA personas — the UI QA agent never explores the shared dev app as an admin

- **Slug:** qa-persona-split
- **Author:** Claude (AI agent)
- **Date:** 2026-11-27
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem
The UI QA agent signs in with the only member of the app's `admin` Cognito group. Settings is admin-only and offers
Save project, Edit, Remove, Add repository and Sync now; AI ROI offers admins "Save overrides". The prompt's STEP 2 said
"interact where sensible (hover chart, click table header, toggle controls)" with no limit, and nothing else in the run
sets one: the harness system prompt tells the agent to "click, type", and the ui-testing skill describes form
submission. The latest run (pr-113, 2026-10-30) explored Settings as that admin. The dev app is shared, so one click on
Remove deletes a project or a tracked repository that other people rely on — and nothing in the run would show that it
happened.

## Desired outcome
- A non-admin account explores every page. The API already refuses it every admin write (`isAdmin` → 403 on the
  registry, defaults and DORA routes).
- The admin account is used only in a separate, read-only pass over the admin pages: reached by URL, read, screenshotted,
  never clicked after sign-in.
- Both prompts forbid write-type controls, setting changes and non-GET requests unless a numbered step of the prompt asks
  for one (none does).
- Every run shows whether the rules held: each browser action is audited from the harness stream, and a violation or a
  login of the wrong persona turns the `qa` check red.
- The admin pass's screenshots (identity ARNs, e-mail addresses) stay out of the prefix the dashboard serves.

## Non-goals
- Creating the non-admin user and its secret, and rotating passwords: owner account actions, with the exact commands in
  the test report.
- The harness system prompt and the ui-testing skill (harness repo; the prompt's rules outrank them).
- Making the audit a proof. It matches selectors, so it is a tripwire: a hit is red, a miss proves nothing.
- Screenshot access on the ops dashboard, the URL allow-list and per-PR environments (separate plan items).
