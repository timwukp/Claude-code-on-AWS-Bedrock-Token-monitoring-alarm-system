# Feature 25 — Settings page (admin registry + DORA repos out of the monitoring pages)

- **Chain:** `intent/settings-and-format/` · **Branch:** `feat/settings-and-format` off `main@2a9630c` (post-#54) · **PR:** TBD
- **Origin:** `docs/research-dashboard-ux.md` defect 9 — admin CRUD embedded in monitoring pages.
- **Date:** 2026-09-21
- **Verdict:** PASS on gates and the local authenticated render; live via qa recorded below.

## What this report has to say plainly
- **Behaviour parity, not redesign.** The two forms moved with the same fields, API calls and confirmations
  (one added: removing a DORA repository now confirms, as removing a project already did). Writes were not
  exercised against dev — they mutate shared data — so parity rests on the moved code being the moved code.
- **The Overview is finally validated end to end** in this run (see the feature-23 report's live section,
  filled in this PR): endpoint deployed, invoked, and rendered with real data.

## Scope
| File | Change |
|---|---|
| `frontend/src/pages/SettingsPage.tsx` | new — Projects + Tracked repositories panels, per-panel busy/status, non-admin state |
| `frontend/src/pages/ProjectsPage.tsx` | admin panel + state/handlers removed; Settings pointer |
| `frontend/src/pages/DoraPage.tsx` | admin panel + repo CRUD state/handlers removed; Settings pointer; copy |
| `frontend/src/main.tsx` | `/settings` route + `PAGE_META` |
| `frontend/src/components/Layout.tsx` | Settings link in the sidebar footer |
| `frontend/src/lib/format.ts` | `fmtInt` |
| `frontend/src/pages/UsagePage.tsx` | Invocations via `fmtInt` |
| `frontend/src/styles.css` | `.nav-link-footer` |

## Gates
| Gate | Result |
|---|---|
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `sdlc_ci_gate.py --require-active` | PASS — 8 source files, all named in the plan |

## Local authenticated render (live dev API, owner's session)
| Check | Result |
|---|---|
| `/settings` (admin) | h1 "Settings"; panels **Projects** and **Tracked repositories (DORA)**; 2 238 px |
| `/projects` | admin form gone; **2 908 → 1 456 px**; Settings pointer present |
| `/dora` | admin form gone; **6 429 → 5 727 px**; Settings pointer present |
| footer | Settings link on every page |
| `/` Overview | live data from the deployed endpoint (see feature-23 report) |
| console / page errors | 0 |

## Live validation (dev)
_Via qa after push:_ served hash; the checks above on the served site.

## Leak scan
`grep -nE '[0-9]{12}|AKIA|arn:aws'`: no matches.
