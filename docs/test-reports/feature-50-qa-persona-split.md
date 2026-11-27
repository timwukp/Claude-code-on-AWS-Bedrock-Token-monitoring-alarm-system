# Feature 50 — QA personas: the UI QA agent never explores the shared dev app as an admin

- **Chain:** `intent/qa-persona-split/` · **Branch:** `fix/qa-persona-split` off `main@7c06d3e` (post-#114) · **Issue:** #121 · **PR:** TBD
- **Origin:** review of the live QA loop, 2026-11-27: the QA login is the app's only `admin` member, and the prompt allowed
  any "sensible" interaction on a page offering Remove.
- **Date:** 2026-11-27
- **Verdict:** PASS on unit checks; live run pending (below).

## What this report has to say plainly
- **Nothing showed a write had ever happened, and nothing would have.** The run recorded screenshots and findings, not the
  actions behind them. This change adds the record (`passes[].browser_actions`, and the admin pass's action trail) as well
  as the rules.
- **The viewer's real protection is the API, not the prompt.** Every registry, defaults and DORA write checks `isAdmin`
  server-side, so a non-admin click on a write control returns 403. The prompt rules and the audit are for the admin pass,
  where the server would accept the write.
- **The audit is a tripwire.** It matches selectors and scripts, so a hit is red and a miss proves nothing; a pass whose
  stream shows no browser action is `unobserved`, a warning, never `ok`.

## Changes
| File | Change |
|---|---|
| `ci-agent/qa_agent.py` | `SAFETY_RULES` in both prompts; viewer pass (`--secret-id`) and read-only admin pass (`--admin-secret-id`, `--admin-pages`), separate sessions, actors and S3 prefixes; `persona_observed`; `safe_stream` collects tool calls; `audit_actions`; `merge_reports`; `readonly` / `persona` outputs |
| `ci-agent/test_agents.py` | 19 new tests (31 total), incl. `main()` end to end against a fake harness |
| `.github/workflows/ui-qa-agent.yml` | persona secrets in job env; `--secret-id` passed explicitly; per-pass line in the PR comment; step **Fail check if a QA pass broke the safety rules**; timeout 150 min |
| `AGENTS.md`, `README.md`, `CHANGELOG.md` | QA loop rule 4; README QA section; changelog entry |

## Unit checks (boto3 stubbed)
| Check | Result |
|---|---|
| `python3 -m unittest test_agents` on Python 3.12 and 3.14 | 31 / 31 PASS |
| Mutation pass: 22 mutants over the audit rules, the no-copy rule, persona mapping, prompts, merge and `main()` wiring | 22 / 22 killed |
| A typed password or a script holding it, in either pass | absent from the audit and the report |
| Workflow YAML parse; PR comment script rendered with a two-pass report and an old-style report | PASS |
| Safety step shell for `ok`, `violated`, `mismatch`, `unobserved`/`unreported`, empty outputs | 0, 1, 1, 0 + warnings, 0 |
| Owner script below, run against a stub `aws` | both passwords meet the pool policy; none on stdout or argv; rotation keeps other secret keys |

## Live verification
Pending: one `workflow_dispatch` run of this branch. Pass criteria: the viewer pass explores all 10 pages with
`persona_check: ok`; the admin pass visits Settings with `persona_check: ok` and `readonly: ok` and no click after Sign in;
the API access log shows no POST/PUT/PATCH/DELETE in the run window.

## Owner account actions (run before the live run)
Creates the non-admin login and its secret, and rotates the admin QA login's password. The secret name matches the harness
execution role's existing `token-monitor-demo/login-creds-*` read grant, so no IAM change is needed.

```bash
#!/usr/bin/env bash
# QA personas — owner-run account actions (feature-50, qa-persona-split).
#   1. create the NON-admin QA login and its secret token-monitor-demo/login-creds-viewer
#   2. rotate the admin QA login's password (secret token-monitor-demo/login-creds)
# Needs AWS CLI v2 with admin credentials for the dev account, and python3.
# Prints no password: each one exists only in a 0700 temp dir that is removed afterwards,
# and reaches the AWS CLI through file:// inputs, never the command line.
set -euo pipefail
export AWS_REGION=us-east-1

POOL_ID=$(aws cognito-idp list-user-pools --max-results 60 \
  --query "UserPools[?Name=='tums-dev'].Id | [0]" --output text)
[ -n "$POOL_ID" ] && [ "$POOL_ID" != None ] || { echo "user pool tums-dev not found" >&2; exit 1; }
ADMIN_SECRET=token-monitor-demo/login-creds
VIEWER_SECRET=token-monitor-demo/login-creds-viewer
VIEWER_USER=qa-viewer@tokenmonitor.local

# new_login <secret-id> <username> create|rotate
#   create: secret = {url (from the admin secret), email: <username>, password}
#   rotate: secret = the current secret with only "password" replaced; the user is its "email"
new_login() {
  local sid=$1 user=$2 mode=$3 d who
  d=$(mktemp -d); chmod 700 "$d"
  if [ "$mode" = create ]; then src=$ADMIN_SECRET; else src=$sid; fi
  aws secretsmanager get-secret-value --secret-id "$src" --query SecretString --output text > "$d/base.json"
  who=$(python3 - "$d" "$POOL_ID" "$user" "$mode" <<'PY'
import json, secrets, string, sys
d, pool, user, mode = sys.argv[1:]
base = json.load(open(f"{d}/base.json"))
sym = "!#%+-=_"  # pool policy: >= 12 chars, upper, number and symbol required
alphabet = string.ascii_letters + string.digits + sym
while True:
    pw = "".join(secrets.choice(alphabet) for _ in range(32))
    if all(any(c in s for c in pw) for s in (string.ascii_uppercase, string.ascii_lowercase, string.digits, sym)):
        break
if mode == "create":
    out = {"url": base["url"], "email": user, "password": pw}
else:
    out, user = dict(base, password=pw), base["email"]
json.dump({"UserPoolId": pool, "Username": user, "Password": pw, "Permanent": True}, open(f"{d}/set.json", "w"))
json.dump(out, open(f"{d}/secret.json", "w"))
print(user)
PY
)
  aws cognito-idp admin-set-user-password --cli-input-json "file://$d/set.json"
  if [ "$mode" = create ]; then
    aws secretsmanager create-secret --name "$sid" --secret-string "file://$d/secret.json" \
      --description "UI QA agent login, non-admin persona (ci-agent/qa_agent.py)" \
      --tags Key=auto-delete,Value=never --query Name --output text
  else
    aws secretsmanager put-secret-value --secret-id "$sid" --secret-string "file://$d/secret.json" \
      --query VersionId --output text
  fi
  rm -f "$d/base.json" "$d/set.json" "$d/secret.json"; rmdir "$d"
  echo "done: $who -> $sid"
}

# 1. The non-admin QA user: no group (so not admin), no invitation e-mail, then a permanent password.
aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username "$VIEWER_USER" \
  --user-attributes Name=email,Value="$VIEWER_USER" Name=email_verified,Value=true \
  --message-action SUPPRESS --query User.UserStatus --output text
new_login "$VIEWER_SECRET" "$VIEWER_USER" create

# 2. Rotate the admin QA login's password (the secret keeps its url and email).
new_login "$ADMIN_SECRET" "" rotate

# 3. Check: the viewer is CONFIRMED and in no group; the admin group still has exactly one member.
aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username "$VIEWER_USER" --query UserStatus --output text
echo "viewer groups: [$(aws cognito-idp admin-list-groups-for-user --user-pool-id "$POOL_ID" \
  --username "$VIEWER_USER" --query 'Groups[].GroupName' --output text)]"
echo "admin members: $(aws cognito-idp list-users-in-group --user-pool-id "$POOL_ID" --group-name admin \
  --query 'length(Users)' --output text)"
```
