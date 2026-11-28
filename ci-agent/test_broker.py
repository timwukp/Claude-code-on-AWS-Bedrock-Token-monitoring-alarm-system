"""Stdlib-only tests for the QA reset broker (run: python3 -m unittest test_broker).
Every constant comes from qa_reset_broker_spec.json / harness_lock_spec.json; fakes stand in for S3, Secrets Manager,
Cognito and Lambda."""
import io
import json
import logging
import os
import random
import sys
import types
import unittest

os.environ.setdefault("AWS_ACCOUNT_ID", "111122223333")
for name in ("boto3", "botocore", "botocore.config"):
    sys.modules.setdefault(name, types.ModuleType(name))

import qa_reset_broker as broker  # noqa: E402
from harness_lock import SPEC as LOCK_SPEC, fmt  # noqa: E402
from qa_reset_broker import SPEC  # noqa: E402

POOL = "us-east-1_TESTPOOL"
MAP = {"viewer": {"secretId": "token-monitor-demo/login-creds-viewer", "username": "qa-viewer@example.test"},
       "admin": {"secretId": "token-monitor-demo/login-creds", "username": "qa-admin@example.test"}}
NOW = 1_800_000_000.0


class AwsError(Exception):
    """Shaped like botocore's ClientError."""
    def __init__(self, code, message="", status=400):
        super().__init__(message or code)
        self.response = {"Error": {"Code": code, "Message": message}, "ResponseMetadata": {"HTTPStatusCode": status}}


class FakeS3:
    def __init__(self, lease=None):
        self.objects = {}
        if lease is not None:
            self.objects[LOCK_SPEC["key"]] = json.dumps(lease).encode() if isinstance(lease, dict) else lease

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise AwsError("NoSuchKey", status=404)
        return {"Body": io.BytesIO(self.objects[Key]), "ETag": '"e1"'}


class FakeSecrets:
    """Secrets Manager with staging labels: AWSCURRENT / AWSPENDING move between versions."""
    def __init__(self, calls):
        self.calls, self.versions, self.n = calls, {}, 0
        for name, m in MAP.items():
            self._add(m["secretId"], json.dumps({"url": "https://app.example/", "email": m["username"],
                                                 "password": f"old-{name}-Aa1!", "note": "keep me"}), {"AWSCURRENT"})
        self.fail_on = None

    def _add(self, sid, s, stages):
        self.n += 1
        vid = f"v{self.n}"
        self.versions.setdefault(sid, {})[vid] = {"string": s, "stages": set(stages)}
        return vid

    def _staged(self, sid, stage):
        return next((v for v, d in self.versions[sid].items() if stage in d["stages"]), None)

    def current(self, sid):
        return json.loads(self.versions[sid][self._staged(sid, "AWSCURRENT")]["string"])

    def get_secret_value(self, SecretId, VersionStage="AWSCURRENT"):
        vid = self._staged(SecretId, VersionStage)
        return {"SecretString": self.versions[SecretId][vid]["string"], "VersionId": vid}

    def put_secret_value(self, SecretId, SecretString, VersionStages):
        self.calls.append(("put_secret_value", SecretId, tuple(VersionStages)))
        if self.fail_on == "put":
            raise AwsError("InternalServiceError")
        for d in self.versions[SecretId].values():
            d["stages"] -= set(VersionStages)
        return {"VersionId": self._add(SecretId, SecretString, VersionStages)}

    def update_secret_version_stage(self, SecretId, VersionStage, MoveToVersionId=None, RemoveFromVersionId=None):
        self.calls.append(("update_secret_version_stage", SecretId, VersionStage, MoveToVersionId, RemoveFromVersionId))
        if self.fail_on == "stage":
            raise AwsError("InternalServiceError")
        holder = self._staged(SecretId, VersionStage)
        if holder is not None and holder != RemoveFromVersionId:
            raise AwsError("InvalidParameterException", "label is attached to another version")
        if RemoveFromVersionId:
            self.versions[SecretId][RemoveFromVersionId]["stages"].discard(VersionStage)
        if MoveToVersionId:
            self.versions[SecretId][MoveToVersionId]["stages"].add(VersionStage)
            self.versions[SecretId][MoveToVersionId]["stages"].discard("AWSPENDING")
        return {}


class FakeCognito:
    def __init__(self, calls):
        self.calls, self.fail_with = calls, None

    def admin_set_user_password(self, UserPoolId, Username, Password, Permanent):
        self.calls.append(("admin_set_user_password", UserPoolId, Username, Permanent))
        self.last_password = Password
        if self.fail_with:
            raise self.fail_with

    def admin_user_global_sign_out(self, UserPoolId, Username):
        self.calls.append(("admin_user_global_sign_out", UserPoolId, Username))
        return {}


def lease(run_id="run-1", expires=NOW + 600):
    return {"owner": "ci:1", "runId": run_id, "acquiredAt": fmt(NOW - 60), "expiresAt": fmt(expires)}


class World:
    def __init__(self, lease_obj=lease()):
        self.calls = []
        self.s3, self.secrets, self.cognito = FakeS3(lease_obj), FakeSecrets(self.calls), FakeCognito(self.calls)
        self.config = broker.Config(user_pool_id=POOL, bucket="qa-bucket", secret_map=MAP)

    def rotate(self, secret="viewer", run_id="run-1", sign_out=False, **kw):
        event = {"action": "rotate", "secret": secret, "runId": run_id, "signOut": sign_out, **kw}
        return broker.handle(event, s3=self.s3, secrets=self.secrets, cognito=self.cognito, config=self.config,
                             clock=lambda: NOW, rng=random.Random(7))


class BrokerSpecTest(unittest.TestCase):
    def test_the_spec_is_the_single_source(self):
        self.assertEqual((SPEC["spec"], SPEC["version"]), ("qa-reset-broker", 1))
        self.assertEqual(len(SPEC["checkOrder"]), 3)
        self.assertEqual([w.split("(")[0] for w in SPEC["writeOrder"]],
                         ["PutSecretValue", "AdminSetUserPassword", "AdminUserGlobalSignOut", "UpdateSecretVersionStage"])
        self.assertTrue(set(broker.ERRORS) == set(SPEC["errors"]))
        self.assertGreaterEqual(SPEC["passwordPolicy"]["length"], SPEC["passwordPolicy"]["poolMinimum"])


class BrokerRefusalTest(unittest.TestCase):
    def assert_refused(self, world, out, error):
        self.assertEqual(out, {"ok": False, "error": error})
        self.assertEqual(world.calls, [])  # nothing written anywhere

    def test_no_lease(self):
        w = World(lease_obj=None)
        self.assert_refused(w, w.rotate(), "no-lease")

    def test_an_unreadable_lease_counts_as_none(self):
        w = World(lease_obj=b"not json")
        self.assert_refused(w, w.rotate(), "no-lease")

    def test_a_lease_held_by_another_run(self):
        w = World()
        self.assert_refused(w, w.rotate(run_id="run-2"), "lease-not-yours")

    def test_an_expired_lease(self):
        w = World(lease_obj=lease(expires=NOW))
        self.assert_refused(w, w.rotate(), "lease-expired")

    def test_an_unknown_secret(self):
        w = World()
        self.assert_refused(w, w.rotate(secret="root"), "unknown-secret")

    def test_the_lease_is_checked_before_the_secret(self):
        w = World(lease_obj=None)
        self.assert_refused(w, w.rotate(secret="root"), "no-lease")

    def test_bad_requests(self):
        for bad in ({"action": "delete"}, {"runId": ""}, {"secret": ""}, {"signOut": "yes"}):
            w = World()
            event = {"action": "rotate", "secret": "viewer", "runId": "run-1", "signOut": False, **bad}
            out = broker.handle(event, s3=w.s3, secrets=w.secrets, cognito=w.cognito, config=w.config,
                                clock=lambda: NOW, rng=random.Random(1))
            self.assert_refused(w, out, "bad-request")

    def test_a_weak_password_is_refused_before_any_write(self):
        w = World()
        real = broker.generate_password
        broker.generate_password = lambda rng=None: "short"
        try:
            self.assert_refused(w, w.rotate(), "policy")
        finally:
            broker.generate_password = real


class BrokerPolicyTest(unittest.TestCase):
    def test_a_thousand_seeded_passwords_meet_the_policy(self):
        rng = random.Random(20261128)
        pol = SPEC["passwordPolicy"]
        for _ in range(1000):
            pw = broker.generate_password(rng)
            self.assertTrue(broker.policy_ok(pw), pw)
            self.assertEqual(len(pw), pol["length"])
            self.assertTrue(set(pw) <= set(pol["alphabet"]))

    def test_policy_ok_rejects_each_missing_class(self):
        good = broker.generate_password(random.Random(3))
        self.assertTrue(broker.policy_ok(good))
        sym = SPEC["passwordPolicy"]["symbols"]
        for bad in (good[:11], good.lower(), good.upper(), "".join(c for c in good if not c.isdigit()).ljust(32, "a"),
                    "".join("a" if c in sym else c for c in good), good[:-1] + " "):
            self.assertFalse(broker.policy_ok(bad), bad)


class BrokerWriteTest(unittest.TestCase):
    def test_a_rotation_writes_in_the_spec_order_and_returns_the_new_version(self):
        w = World()
        out = w.rotate(sign_out=True)
        sid, user = MAP["viewer"]["secretId"], MAP["viewer"]["username"]
        self.assertEqual([c[0] for c in w.calls],
                         ["put_secret_value", "admin_set_user_password", "admin_user_global_sign_out",
                          "update_secret_version_stage"])
        self.assertEqual(w.calls[0][2], ("AWSPENDING",))
        self.assertEqual(w.calls[1][1:], (POOL, user, True))
        new_vid = w.calls[3][3]
        self.assertEqual(out, {"ok": True, "versionId": new_vid})
        cur = w.secrets.current(sid)
        self.assertEqual((cur["url"], cur["email"], cur["note"]), ("https://app.example/", user, "keep me"))
        self.assertEqual(cur["password"], w.cognito.last_password)
        self.assertNotEqual(cur["password"], "old-viewer-Aa1!")
        self.assertIsNone(w.secrets._staged(sid, "AWSPENDING"))

    def test_no_sign_out_unless_asked(self):
        w = World()
        w.rotate(sign_out=False)
        self.assertNotIn("admin_user_global_sign_out", [c[0] for c in w.calls])

    def test_cognito_gets_only_the_mapped_username(self):
        w = World()
        w.rotate(secret="admin", username="someone-else@example.test", secretId="other/secret")
        users = {c[2] for c in w.calls if c[0].startswith("admin_")}
        self.assertEqual(users, {MAP["admin"]["username"]})
        self.assertEqual({c[1] for c in w.calls if "secret" in c[0]}, {MAP["admin"]["secretId"]})

    def test_a_cognito_failure_leaves_awscurrent_on_the_old_pair(self):
        w = World()
        w.cognito.fail_with = AwsError("InvalidPasswordException")
        out = w.rotate()
        self.assertEqual(out, {"ok": False, "error": "write-failed"})
        self.assertEqual(w.secrets.current(MAP["viewer"]["secretId"])["password"], "old-viewer-Aa1!")
        self.assertNotIn("update_secret_version_stage", [c[0] for c in w.calls])

    def test_a_failed_stage_move_leaves_awscurrent_on_the_old_pair(self):
        w = World()
        w.secrets.fail_on = "stage"
        self.assertEqual(w.rotate(), {"ok": False, "error": "write-failed"})
        self.assertEqual(w.secrets.current(MAP["viewer"]["secretId"])["password"], "old-viewer-Aa1!")

    def test_a_second_rotation_after_a_failed_one_repairs(self):
        w = World()
        w.secrets.fail_on = "stage"
        w.rotate()
        w.secrets.fail_on = None
        self.assertTrue(w.rotate()["ok"])
        self.assertEqual(w.secrets.current(MAP["viewer"]["secretId"])["password"], w.cognito.last_password)


class BrokerLeakTest(unittest.TestCase):
    def test_the_password_is_in_no_response_log_or_exception(self):
        w = World()
        # An AWS error whose message echoes its input (a worst case) must not carry the password out.
        class Echo(FakeCognito):
            def admin_set_user_password(self, UserPoolId, Username, Password, Permanent):
                self.last_password = Password
                raise AwsError("InvalidPasswordException", f"password {Password} rejected")
        w.cognito = Echo(w.calls)
        with self.assertLogs(broker.LOG, level="DEBUG") as logs:
            broker.LOG.debug("start")
            out = w.rotate()
        pw = w.cognito.last_password
        self.assertNotIn(pw, json.dumps(out))
        self.assertFalse(any(pw in r for r in logs.output), logs.output)

    def test_an_unexpected_exception_does_not_carry_the_password(self):
        w = World()
        class Boom(FakeCognito):
            def admin_set_user_password(self, UserPoolId, Username, Password, Permanent):
                self.last_password = Password
                raise RuntimeError(f"boom {Password}")
        w.cognito = Boom(w.calls)
        try:
            out = w.rotate()
            text = json.dumps(out)
        except Exception as e:  # noqa: BLE001
            text = f"{e} {e!r}"
        self.assertNotIn(w.cognito.last_password, text)

    def test_a_successful_rotation_logs_no_password(self):
        w = World()
        with self.assertLogs(broker.LOG, level="DEBUG") as logs:
            broker.LOG.debug("start")
            w.rotate(sign_out=True)
        self.assertFalse(any(w.cognito.last_password in r for r in logs.output))


class BrokerClientTest(unittest.TestCase):
    class FakeLambda:
        def __init__(self, reply=None, error=None, function_error=None):
            self.reply, self.error, self.function_error, self.calls = reply, error, function_error, []

        def invoke(self, FunctionName, InvocationType, Payload):
            self.calls.append((FunctionName, InvocationType, json.loads(Payload)))
            if self.error:
                raise self.error
            out = {"Payload": io.BytesIO(json.dumps(self.reply).encode()), "StatusCode": 200}
            if self.function_error:
                out["FunctionError"] = self.function_error
            return out

    def test_call_rotate_sends_the_request_and_returns_the_reply(self):
        lam = self.FakeLambda(reply={"ok": True, "versionId": "v9"})
        self.assertEqual(broker.call_rotate(lam, "qa-login-reset", "viewer", "run-1", sign_out=True),
                         {"ok": True, "versionId": "v9"})
        self.assertEqual(lam.calls, [("qa-login-reset", "RequestResponse",
                                      {"action": "rotate", "secret": "viewer", "runId": "run-1", "signOut": True})])

    def test_an_unreachable_or_failing_broker_raises(self):
        for lam in (self.FakeLambda(error=AwsError("ResourceNotFoundException", status=404)),
                    self.FakeLambda(reply={"errorMessage": "x"}, function_error="Unhandled"),
                    # a FunctionError is a failure even when the payload happens to look like a reply
                    self.FakeLambda(reply={"ok": True, "versionId": "v1"}, function_error="Unhandled")):
            with self.assertRaises(broker.BrokerUnavailable):
                broker.call_rotate(lam, "qa-login-reset", "viewer", "run-1", sign_out=False)

    def test_a_refusal_is_returned_not_raised(self):
        lam = self.FakeLambda(reply={"ok": False, "error": "lease-not-yours"})
        self.assertEqual(broker.call_rotate(lam, "qa-login-reset", "viewer", "run-1", sign_out=False),
                         {"ok": False, "error": "lease-not-yours"})



class BrokerLambdaWiringTest(unittest.TestCase):
    """The deploy path: lambda_handler builds its three clients from boto3 and its config from the environment."""
    def test_lambda_handler_wires_clients_and_env_config(self):
        w = World()
        clients = {"s3": w.s3, "secretsmanager": w.secrets, "cognito-idp": w.cognito}
        made = []
        real_client = getattr(sys.modules["boto3"], "client", None)
        sys.modules["boto3"].client = lambda name, **k: (made.append(name), clients[name])[1]
        env = {"QA_BROKER_USER_POOL_ID": POOL, "QA_BROKER_LOCK_BUCKET": "qa-bucket", "QA_BROKER_SECRET_MAP": json.dumps(MAP)}
        saved = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        real_clock = broker.time.time
        broker.time.time = lambda: NOW
        try:
            out = broker.lambda_handler({"action": "rotate", "secret": "viewer", "runId": "run-1", "signOut": False}, None)
        finally:
            broker.time.time = real_clock
            sys.modules["boto3"].client = real_client
            for k, v in saved.items():
                os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
        self.assertTrue(out["ok"], out)
        self.assertEqual(sorted(made), ["cognito-idp", "s3", "secretsmanager"])

    def test_a_missing_env_setting_fails_loudly(self):
        saved = {k: os.environ.pop(k, None) for k in ("QA_BROKER_USER_POOL_ID", "QA_BROKER_LOCK_BUCKET", "QA_BROKER_SECRET_MAP")}
        try:
            with self.assertRaises(KeyError):
                broker.Config.from_env()
        finally:
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v

if __name__ == "__main__":
    unittest.main()
