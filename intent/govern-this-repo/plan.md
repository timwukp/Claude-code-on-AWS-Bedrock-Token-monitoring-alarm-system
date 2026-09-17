# Plan: eleven new files, second governed repo

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** f21fac9e0b0989835c50ccc9df5afbbc1206ecee
- **Status:** accepted

`Accepted-for` is main's tip at acceptance (no divergent local tree exists; there is no
local clone of this repository on the owner's machine, so the write-time hook takes
effect on first clone/pull after merge).

## Files changed (all new)

1. `.sdlc/scripts/sdlc_pretooluse_hook.py` — vendored from the skill
2. `.sdlc/scripts/sdlc_gate.py` — vendored
3. `.sdlc/scripts/sdlc_ci_gate.py` — vendored
4. `.kiro/hooks/sdlc-gate.json` — Kiro surface
5. `.claude/settings.json` — Claude Code surface (repo had none; no merge needed)
6. `.github/workflows/sdlc-gate.yml` — CI gate, Monitor mode (not required)
7. `.sdlc/active` — `govern-this-repo`
8. `.sdlc/version` — artifact schema 1
9-11. `intent/govern-this-repo/{intent,spec,plan}.md` — this chain

## Verification

- In a fresh clone at the recorded base: both surfaces' hook commands exercised with
  surface-shaped stdin events — accepted chain exits 0, draft-chain fixture exits 2.
- `sdlc_ci_gate.py --repo . --require-active --base-sha f21fac9…` over the installation
  file list passes.
- Scripts are byte-identical to the skill's tested copies (vendored unmodified).
