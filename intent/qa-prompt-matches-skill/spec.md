# Spec: QA prompt matches the skill

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

## Behaviour
1. `ci-agent/qa_agent.py`:
   - `LOGIN_STEPS`, STEP 0: read the secret with boto3 from `shell` (`python3 - <<'EOF' … EOF`), printing url, email and
     password. Say that the code interpreter has no AWS credentials. Say that the password enters the context once, for
     `type`, and is not repeated in text, files, reports, findings, evidence, file names or the final JSON.
     `SecretId="{secret_id}"` is unchanged.
   - `REPORT_STEPS`, STEP 3: write `/mnt/reports/…` and upload it to `s3://{bucket}/{run_prefix}/` with boto3 from
     `shell`.
   - No other prompt text and no code path changes.
2. `ci-agent/test_agents.py`: one new test. For both personas: STEP 0 names `shell` and `get_secret_value`; STEP 3 names
   `shell` and the S3 prefix; neither says "use / with the code interpreter"; STEP 0 no longer says "never echo the
   password" and carries the "Don't repeat it anywhere else" rule.

## Acceptance
- Unit: `python3 -m unittest test_agents` passes 44 tests (43 before) on Python 3.12 and 3.14. The new test fails when
  either half is reverted. PR #122's 24 mutants and PR #130's 12 mutants are still killed.
- Live: one signed-in run, in a slot the main session gives, followed by a password rotation. One `qa_agent.py` run of
  this prompt against the live UI harness (v9). It passes when, in both passes:
  - the first AWS tool after `skills` is `shell`, with no code_interpreter call before it;
  - sign-in works, and the viewer tests 10 pages;
  - `persona` and `readonly` are ok.
