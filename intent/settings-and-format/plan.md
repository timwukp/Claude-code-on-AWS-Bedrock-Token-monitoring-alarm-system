# Plan: Settings page (feature-25)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 2a9630cad20a9437afa3a5d7eb122bc9bddaaec0
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #54 (feature-24), the merge base at branch time. Nothing else
is in flight.

## Files changed
1. `frontend/src/pages/SettingsPage.tsx` — new: both admin panels, own state/handlers, non-admin state.
2. `frontend/src/pages/ProjectsPage.tsx` — admin panel, form state and handlers removed; Settings pointer.
3. `frontend/src/pages/DoraPage.tsx` — admin panel, repo CRUD state and handlers removed; Settings pointer; copy.
4. `frontend/src/main.tsx` — `/settings` route and `PAGE_META` entry.
5. `frontend/src/components/Layout.tsx` — Settings link in the sidebar footer.
6. `frontend/src/lib/format.ts` — `fmtInt`.
7. `frontend/src/pages/UsagePage.tsx` — Invocations via `fmtInt`.
8. `frontend/src/styles.css` — `.nav-link-footer`.

Non-source riders: `.sdlc/active` (handover from `roi-cost-tables`), `intent/roi-cost-tables/*` → shipped (my
own predecessor), `intent/settings-and-format/*`, `CHANGELOG.md`, `docs/test-reports/feature-25-settings-and-format.md`
plus its index row, and `docs/test-reports/feature-23-overview-page.md` (live-validation section filled in
now that `/v1/overview` is deployed — docs only).

## Verification
- frontend `tsc --noEmit` + `vite build`; SDLC gate dry-run.
- Local authenticated render: `/settings` shows both panels for an admin; `/projects` and `/dora` no longer
  contain the forms (page heights 2 908 → 1 456 px and 6 429 → 5 727 px) and show the Settings pointer; the
  footer link is present on every page; Overview renders live data from the deployed endpoint.
- Live via qa after push.

## Risks
- Behaviour parity of the moved forms: same API calls, same confirmations; verified by exercising Save/Edit
  paths locally against the live registry read (writes not exercised — they mutate shared dev data).
