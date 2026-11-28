"""QA reset broker: per-run passwords for the two QA logins of the shared dev app (feature-53).

The rules are in qa_reset_broker_spec.json, next to this file; read them there. In short, the broker:
- rotates a login only while the caller holds the UI harness lease (harness_lock_spec.json);
- maps the request's secret name to a username fixed at deploy time;
- writes in an order that leaves AWSCURRENT on the old pair if a step fails;
- never lets the password reach a response, a log record, an exception or a trace.

`handle()` is the pure part (clients injected); `lambda_handler()` wires boto3 for AWS Lambda; `call_rotate()` is what
callers (qa_agent.py, harness_lock_cli.py) use.
"""
import json
import logging
import os
import secrets as _secrets
import time

from harness_lock import parse, valid_lease, SPEC as LOCK_SPEC

SPEC = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "qa_reset_broker_spec.json"),
                      encoding="utf-8"))
ERRORS = tuple(SPEC["errors"])
POLICY = SPEC["passwordPolicy"]
LOG = logging.getLogger("qa_reset_broker")


class BrokerUnavailable(Exception):
    """The broker could not be called, or failed without answering (a caller fails closed on this)."""


class Config:
    def __init__(self, user_pool_id: str, bucket: str, secret_map: dict):
        self.user_pool_id, self.bucket, self.secret_map = user_pool_id, bucket, secret_map

    @classmethod
    def from_env(cls):
        return cls(os.environ["QA_BROKER_USER_POOL_ID"], os.environ["QA_BROKER_LOCK_BUCKET"],
                   json.loads(os.environ["QA_BROKER_SECRET_MAP"]))


def policy_ok(pw) -> bool:
    if not isinstance(pw, str) or len(pw) < max(POLICY["poolMinimum"], POLICY["length"]):
        return False
    if not set(pw) <= set(POLICY["alphabet"]):
        return False
    checks = (("requireUpper", str.isupper), ("requireLower", str.islower), ("requireDigit", str.isdigit))
    if any(POLICY[k] and not any(f(c) for c in pw) for k, f in checks):
        return False
    return not POLICY["requireSymbol"] or any(c in POLICY["symbols"] for c in pw)


def generate_password(rng=None) -> str:
    """One character from each required class, the rest from the alphabet, shuffled. `rng` is injectable for tests;
    the default is the OS CSPRNG."""
    rng = rng or _secrets.SystemRandom()
    alpha = POLICY["alphabet"]
    pools = [[c for c in alpha if c.isupper()], [c for c in alpha if c.islower()], [c for c in alpha if c.isdigit()],
             list(POLICY["symbols"])]
    chars = [rng.choice(p) for p in pools] + [rng.choice(alpha) for _ in range(POLICY["length"] - len(pools))]
    rng.shuffle(chars)
    return "".join(chars)


def _code(e) -> str:
    r = getattr(e, "response", None) or {}
    return str((r.get("Error") or {}).get("Code") or type(e).__name__)


def _refuse(error: str, why: str = "") -> dict:
    LOG.warning("refused: %s%s", error, f" ({why})" if why else "")
    return {"ok": False, "error": error}


def _bad(event) -> bool:
    return (not isinstance(event, dict) or event.get("action") != "rotate"
            or not isinstance(event.get("secret"), str) or not event.get("secret")
            or not isinstance(event.get("runId"), str) or not event.get("runId")
            or not isinstance(event.get("signOut", False), bool))


def handle(event, *, s3, secrets, cognito, config: Config, clock=time.time, rng=None) -> dict:
    """One rotation, following the spec's checkOrder then writeOrder. Returns {ok, versionId} or {ok: False, error}."""
    if _bad(event):
        return _refuse("bad-request")
    run_id, name, sign_out = event["runId"], event["secret"], event.get("signOut", False)

    # check 1: the lease is held by this runId and has not expired
    try:
        obj = s3.get_object(Bucket=config.bucket, Key=LOCK_SPEC["key"])
        lease = valid_lease(obj["Body"].read())
    except Exception as e:  # noqa: BLE001 — no object (404) or unreadable: either way, no lease
        LOG.info("lease read: %s", _code(e))
        lease = None
    if lease is None:
        return _refuse("no-lease")
    if lease["runId"] != run_id:
        return _refuse("lease-not-yours", f"held by {lease['owner']}")
    if clock() >= parse(lease["expiresAt"]):
        return _refuse("lease-expired")

    # check 2: the secret is one the deploy configured; the username comes from the map, never from the request
    entry = config.secret_map.get(name)
    if not entry:
        return _refuse("unknown-secret")
    secret_id, username = entry["secretId"], entry["username"]

    # check 3: the password meets the policy, before anything is written
    password = generate_password(rng)
    if not policy_ok(password):
        return _refuse("policy")

    step, body = "read", None
    try:
        cur = secrets.get_secret_value(SecretId=secret_id, VersionStage="AWSCURRENT")
        old_version = cur["VersionId"]
        body = json.loads(cur["SecretString"])
        body["password"] = password
        step = "PutSecretValue"
        new_version = secrets.put_secret_value(SecretId=secret_id, SecretString=json.dumps(body),
                                               VersionStages=["AWSPENDING"])["VersionId"]
        step = "AdminSetUserPassword"
        cognito.admin_set_user_password(UserPoolId=config.user_pool_id, Username=username, Password=password,
                                        Permanent=True)
        if sign_out:
            step = "AdminUserGlobalSignOut"
            cognito.admin_user_global_sign_out(UserPoolId=config.user_pool_id, Username=username)
        step = "UpdateSecretVersionStage"
        secrets.update_secret_version_stage(SecretId=secret_id, VersionStage="AWSCURRENT",
                                            MoveToVersionId=new_version, RemoveFromVersionId=old_version)
    except Exception as e:  # noqa: BLE001 — report the step and the AWS code only: an AWS message may echo input
        return _refuse("write-failed", f"{step}: {_code(e)}")
    finally:
        # Drop this frame's two references to the password (the string and the secret body that embeds it), so no
        # later code here, nor a traceback that captures locals, can reach it. Python can't wipe the string's memory.
        password = body = None  # noqa: F841
    LOG.info("rotated %s (signOut=%s) for run %s -> version %s", name, sign_out, run_id, new_version)
    return {"ok": True, "versionId": new_version}


def lambda_handler(event, context):
    """AWS Lambda entry point (handler: qa_reset_broker.lambda_handler)."""
    import boto3
    return handle(event, s3=boto3.client("s3"), secrets=boto3.client("secretsmanager"),
                  cognito=boto3.client("cognito-idp"), config=Config.from_env(), clock=time.time)


def call_rotate(lambda_client, function_name: str, secret: str, run_id: str, sign_out: bool) -> dict:
    """Ask the broker to rotate one login. Returns its reply ({ok, ...}); raises BrokerUnavailable when it cannot be
    reached or failed without a reply. The reply never contains a password, so it is safe to print."""
    req = {"action": "rotate", "secret": secret, "runId": run_id, "signOut": bool(sign_out)}
    try:
        out = lambda_client.invoke(FunctionName=function_name, InvocationType="RequestResponse",
                                   Payload=json.dumps(req))
        reply = json.loads(out["Payload"].read())
    except Exception as e:  # noqa: BLE001
        raise BrokerUnavailable(f"{function_name}: {_code(e)}") from None
    if out.get("FunctionError") or not isinstance(reply, dict) or "ok" not in reply:
        raise BrokerUnavailable(f"{function_name}: {out.get('FunctionError') or 'no reply'}")
    return {"ok": bool(reply["ok"]), **({"versionId": reply["versionId"]} if reply.get("ok") else
                                       {"error": str(reply.get("error"))})}
