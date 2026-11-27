# Feature 50 — QA personas: the UI QA agent never explores the shared dev app as an admin

- **Chain:** `intent/qa-persona-split/` · **Branch:** `fix/qa-persona-split` off `main@7c06d3e` (post-#114) · **Issue:** #121 · **PR:** TBD
- **Origin:** review of the live QA loop, 2026-11-27: the QA login is the app's only `admin` member, and the prompt allowed
  any "sensible" interaction on a page offering Remove.
- **Date:** 2026-11-27
- **Verdict:** PASS on unit checks. Live run 1: the admin pass met its criterion; the viewer pass was blocked by a setup
  gap in the owner script, and the check went red on an audit false positive. Both fixed; run 2 pending (below).

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
| `ci-agent/test_agents.py` | 20 new tests (32 total), incl. `main()` end to end against a fake harness and the run-1 false positive verbatim |
| `.github/workflows/ui-qa-agent.yml` | persona secrets in job env; `--secret-id` passed explicitly; per-pass line in the PR comment; step **Fail check if a QA pass broke the safety rules**; timeout 150 min |
| `AGENTS.md`, `README.md`, `CHANGELOG.md` | QA loop rule 4; README QA section; changelog entry |

## Unit checks (boto3 stubbed)
| Check | Result |
|---|---|
| `python3 -m unittest test_agents` on Python 3.12 and 3.14 | 32 / 32 PASS |
| Mutation pass: 24 mutants over the audit rules (incl. the sign-in exemption both ways), the no-copy rule, persona mapping, prompts, merge and `main()` wiring | 24 / 24 killed |
| A typed password or a script holding it, in either pass | absent from the audit and the report |
| Workflow YAML parse; PR comment script rendered with a two-pass report and an old-style report | PASS |
| Safety step shell for `ok`, `violated`, `mismatch`, `unobserved`/`unreported`, empty outputs | 0, 1, 1, 0 + warnings, 0 |
| Owner script below, against a stateful stub `aws`: fresh install, repair of a tenant-less viewer, re-run when correct | viewer always ends in the admin login's tenant; passwords meet the pool policy and match their secret; none on stdout or argv; rotation keeps other secret keys |

## Live verification

### Run 1 — `workflow_dispatch` 46007195822, 2026-11-27 13:26:57Z, commit `6097154`: red, for two reasons that were both mine
QA step 4 min 38 s for both passes. Data snapshots at 13:26:45Z (before) and 13:33:24Z (after).

| Check | Result |
|---|---|
| Admin pass visits Settings as an admin | ✅ `persona_check: ok` (saw `admin`), 1 page |
| Admin pass is read-only | ✅ `readonly: ok`. Trail: navigate `/`, get_html, type `#email`, type `#password`, click `button[type=submit]`, screenshot, navigate `/settings`, screenshot, get_text. No click after Sign in |
| Independent record of the same calls (Bedrock model-invocation log) | Same per-session counts as the audit. Admin: init 1, navigate 2, type 2, click 1, screenshot 2, get_html 1, get_text 1. Viewer: init 1, navigate 12, evaluate 20, type 4, click 4, screenshot 13 (clicks: Sign in, Retry, the Full-view toggle, Sign out) |
| Shared app data unchanged | Project registry (31 items) and DORA repository list (8 items): SHA-256 identical before and after. DORA collector (6-hourly; "Sync now" and "Add repository" start it): no start in the window |
| Viewer pass explores 10 pages as a non-admin | ⚠️ `persona_check: ok` (saw `non-admin`), `pages_tested: 10`, **but 8 of 10 pages failed to load**: the viewer had no `custom:tenantId`, so the API refused every call ("Missing tenant claim on token"). The owner script did not set it. **Fixed:** the script now copies the admin QA login's tenant at creation, and recreates a viewer without it — the attribute is immutable, and Cognito writes an immutable attribute only at user creation |
| Read-only audit | ❌ `readonly: violated` on the viewer, from one `evaluate` script that clicked `button[type=submit]` to re-check the Sign in button's loading state (prior finding F-004). **False positive:** the script rule lacked the click rule's sign-in exemption. **Fixed**, with that script as a regression test |

The admin pass also filed two LOW findings on Settings (22 registry projects against 8 tracked DORA repositories; repo
names that differ between the two panels). Three of the four stale `pr-manual` findings from July re-verified FIXED; F-004
(no loading state on Sign in) still fails.

### Run 2 — pending
After the owner re-runs the script with `ROTATE_ADMIN=no` (repairs the viewer). Pass criteria unchanged: the viewer pass
explores all 10 pages with `persona_check: ok` and the pages load; the admin pass visits Settings with `persona_check: ok`
and `readonly: ok`; the registry and DORA data are unchanged and the collector does not start.

## Owner account actions (run before the live run)
Creates (or repairs) the non-admin login and its secret, and rotates the admin QA login's password (`ROTATE_ADMIN=no` skips
that). Safe to re-run. The secret name matches the harness
execution role's existing `token-monitor-demo/login-creds-*` read grant, so no IAM change is needed.

```bash
#!/usr/bin/env bash
# QA personas — owner-run account actions (feature-50, qa-persona-split).
#   1. create (or repair) the NON-admin QA login and its secret token-monitor-demo/login-creds-viewer
#   2. rotate the admin QA login's password (secret token-monitor-demo/login-creds); ROTATE_ADMIN=no skips it
# Safe to re-run. Needs AWS CLI v2 with admin credentials for the dev account, and python3.
# Prints no password: each one exists only in a 0700 temp dir that is removed afterwards,
# and reaches the AWS CLI through file:// inputs, never the command line.
set -euo pipefail
export AWS_REGION=us-east-1
ROTATE_ADMIN=${ROTATE_ADMIN:-yes}

POOL_ID=$(aws cognito-idp list-user-pools --max-results 60 \
  --query "UserPools[?Name=='tums-dev'].Id | [0]" --output text)
[ -n "$POOL_ID" ] && [ "$POOL_ID" != None ] || { echo "user pool tums-dev not found" >&2; exit 1; }
ADMIN_SECRET=token-monitor-demo/login-creds
VIEWER_SECRET=token-monitor-demo/login-creds-viewer
VIEWER_USER=qa-viewer@tokenmonitor.local

# Every API call is scoped by the token's custom:tenantId (backend/lambdas/shared/tenant.ts); without it each
# page fails with "Missing tenant claim". The attribute is immutable, and Cognito writes an immutable attribute
# only when the user is created — so the viewer is created with the admin QA login's tenant, or recreated.
ADMIN_USER=$(aws secretsmanager get-secret-value --secret-id "$ADMIN_SECRET" --query SecretString --output text \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["email"])')
tenant_of() {
  aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username "$1" \
    --query 'UserAttributes[?Name==`custom:tenantId`].Value | [0]' --output text 2>/dev/null || echo MISSING
}
TENANT=$(tenant_of "$ADMIN_USER")
[ -n "$TENANT" ] && [ "$TENANT" != None ] && [ "$TENANT" != MISSING ] \
  || { echo "the admin QA login has no custom:tenantId" >&2; exit 1; }

# new_login <secret-id> <username> create|rotate
#   create: secret = {url (from the admin secret), email: <username>, password}
#   rotate: secret = the current secret with only "password" replaced; the user is its "email"
new_login() {
  local sid=$1 user=$2 mode=$3 d who src
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

# 1. The non-admin QA user: the admin QA login's tenant, no group (so not admin), no invitation e-mail.
have=$(tenant_of "$VIEWER_USER")
if [ "$have" != "$TENANT" ]; then
  if [ "$have" != MISSING ]; then
    echo "viewer exists without the admin's tenant: recreating it (custom:tenantId is immutable)"
    aws cognito-idp admin-delete-user --user-pool-id "$POOL_ID" --username "$VIEWER_USER"
  fi
  aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username "$VIEWER_USER" \
    --user-attributes Name=email,Value="$VIEWER_USER" Name=email_verified,Value=true \
      Name=custom:tenantId,Value="$TENANT" \
    --message-action SUPPRESS --query User.UserStatus --output text
fi
if aws secretsmanager describe-secret --secret-id "$VIEWER_SECRET" >/dev/null 2>&1; then
  new_login "$VIEWER_SECRET" "$VIEWER_USER" rotate   # the secret exists: new password, same url + email
else
  new_login "$VIEWER_SECRET" "$VIEWER_USER" create
fi

# 2. Rotate the admin QA login's password (the secret keeps its url and email).
if [ "$ROTATE_ADMIN" = yes ]; then new_login "$ADMIN_SECRET" "" rotate; fi

# 3. Check: the viewer is CONFIRMED, in no group and in the admin's tenant; the admin group has one member.
aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username "$VIEWER_USER" --query UserStatus --output text
echo "viewer groups: [$(aws cognito-idp admin-list-groups-for-user --user-pool-id "$POOL_ID" \
  --username "$VIEWER_USER" --query 'Groups[].GroupName' --output text)]"
echo "viewer tenant = admin tenant: $([ "$(tenant_of "$VIEWER_USER")" = "$TENANT" ] && echo yes || echo NO)"
echo "admin members: $(aws cognito-idp list-users-in-group --user-pool-id "$POOL_ID" --group-name admin \
  --query 'length(Users)' --output text)"
```
