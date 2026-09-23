# Spec: Settings page

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

## Behaviour

### 1. `pages/SettingsPage.tsx` (new), route `/settings`
- Loads `api.projectRegistry()` and `api.doraRepos()` together; `isAdmin` = either response's flag.
- Non-admin → `EmptyState` (shield icon) "Administrator access required" + "Back to Overview".
- **Projects** panel (help `project.tracked`): the former By-project admin form — id, display name, cost
  center, repos (CSV), identity ARNs (CSV); Save; table with Edit / Remove (confirm) — behaviour unchanged;
  empty state when the registry is empty; the AIP explanatory paragraph kept.
- **Tracked repositories (DORA)** panel (help `dora.deployment-frequency`): add (Enter or button), per-row
  Sync now / Remove (confirm added — DORA had none), status badges; a warning line when the collector token
  is not configured; empty state when none are tracked.
- Each panel has its own busy flag and status message (`role="status"`), so a project save cannot disable
  the repository form.

### 2. `pages/ProjectsPage.tsx`, `pages/DoraPage.tsx`
Admin panels and their state/handlers removed; admins see one muted line linking to Settings; copy that
said "add one below" / "manage projects on the By Project page" now points to Settings.

### 3. Shell
`main.tsx`: `/settings` route + `PAGE_META` (no time-range picker). `Layout.tsx`: Settings link with the
`settings` icon above the user line in the sidebar footer. `styles.css`: `.nav-link-footer`.

### 4. Formatting
`lib/format.ts`: `fmtInt(n)` = `Math.round(n).toLocaleString('en-US')`. `UsagePage.tsx` Invocations uses it.

### 5. Overview corrections (feature-23 follow-through)
Deployment-frequency tile: chips `all repos` + `proxy`; definition states it combines all synced repositories
while the DORA page shows one. Spend tile: the token figure reads "N input + output + cache-read tokens";
help entries carry the same two caveats. No number changes.

## Out of scope
`fmtTokens`; APIs; ROI assumptions overrides; DORA table lengths.
