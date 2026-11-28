# Intent: QA prompt matches the skill — AWS calls from `shell`, and a login step the agent can follow

- **Slug:** qa-prompt-matches-skill
- **Author:** Claude (AI agent)
- **Date:** 2026-11-28
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem
`ci-agent/qa_agent.py` gives the UI QA agent three instructions the harness cannot carry out. The ui-testing skill
(Harness repo) already says otherwise.
- STEP 0 says to read the login secret with the code interpreter. The AWS-managed code interpreter has no AWS
  credentials. In all 4 passes of 2026-11-27/28 (`aws/spans` call order), the agent called the code interpreter, got
  `NoCredentialsError`, and then read the secret from `shell`.
- STEP 0 also says "never print the password … keep email/password in variables". The browser's `type` action types
  text the model writes, and a variable inside `shell` or the code interpreter cannot reach it, so the rule cannot be
  kept. The agent improvised: one pass printed the password into a shell tool result ("I had to print the password
  there"); another wrote it to a temporary file and read it back.
- STEP 3 says to save and upload the artifacts with the code interpreter. Its sandbox has no AWS credentials and does not
  share the harness filesystem, so a literal reading would never get the screenshots to S3. The agent uploads from
  `shell`, as the skill says.

## Desired outcome
- STEP 0 reads the secret with boto3 from `shell`. It says, as the skill does, that the password passes through the
  model's context once, for the `type` action, and must not be repeated anywhere else.
- STEP 3 writes `/mnt/reports` and uploads it with boto3 from `shell`.
- A unit test keeps both prompts from sending AWS calls to the code interpreter.

## Non-goals
- Making the typed password short-lived (per-run passwords inside a run lock): the next change. For this dev-only
  platform the owner chose it over keeping the password out of the model's context.
- Whether the harness's Memory keeps tool results that contain the password (not checked here).
- The harness's `allowedTools` (Harness repo #80 / #81, applied).
