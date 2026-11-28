"""Stdlib-only tests for the UI harness lease (harness_lock.py; rules in harness_lock_spec.json).
Run: python3 -m unittest test_harness_lock. The fakes here (S3Error, FakeS3Lease, Clock) are shared with test_agents."""
import io
import json
import os
import tempfile
import time
import unittest

import harness_lock
from harness_lock import SPEC, HarnessLock, HeldLease, LockBusy, fmt, parse, valid_lease


class S3Error(Exception):
    """Shaped like botocore's ClientError: .response carries the S3 error code and HTTP status."""
    def __init__(self, code, status):
        super().__init__(code)
        self.response = {"Error": {"Code": code}, "ResponseMetadata": {"HTTPStatusCode": status}}


class FakeS3Lease:
    """S3 conditional writes as the S3 User Guide documents them: PutObject IfNoneMatch='*' / IfMatch=<ETag>,
    DeleteObject IfMatch=<ETag>; 412 on a failed precondition, 404 when the object is missing. Every call is logged
    in `events`, together with the harness calls when mixed into FakeHarness."""
    def __init__(self):
        self.objects, self.events, self._n = {}, [], 0

    def put_object(self, Bucket, Key, Body, ContentType=None, IfNoneMatch=None, IfMatch=None):
        cur = self.objects.get(Key)
        if IfNoneMatch == "*" and cur is not None:
            self.events.append(("put", "412")); raise S3Error("PreconditionFailed", 412)
        if IfMatch is not None:
            if cur is None:
                self.events.append(("put", "404")); raise S3Error("NoSuchKey", 404)
            if cur[1] != IfMatch:
                self.events.append(("put", "412")); raise S3Error("PreconditionFailed", 412)
        self._n += 1
        etag = f'"e{self._n}"'
        self.objects[Key] = (Body if isinstance(Body, bytes) else Body.encode(), etag)
        self.events.append(("put", "ok"))
        return {"ETag": etag}

    def get_object(self, Bucket, Key):
        cur = self.objects.get(Key)
        if cur is None:
            raise S3Error("NoSuchKey", 404)
        return {"Body": io.BytesIO(cur[0]), "ETag": cur[1]}

    def delete_object(self, Bucket, Key, IfMatch=None):
        cur = self.objects.get(Key)
        if cur is None:
            self.events.append(("delete", "404")); raise S3Error("NoSuchKey", 404)
        if IfMatch is not None and cur[1] != IfMatch:
            self.events.append(("delete", "412")); raise S3Error("PreconditionFailed", 412)
        del self.objects[Key]
        self.events.append(("delete", "ok"))
        return {}

    def lease(self):
        cur = self.objects.get(SPEC["key"])
        return json.loads(cur[0]) if cur else None



class Clock:
    """An injected clock: sleep() advances time instead of waiting."""
    def __init__(self, t=1_800_000_000.0):
        self.t, self.sleeps = t, 0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s
        self.sleeps += 1


class HarnessLockSpecTest(unittest.TestCase):
    def test_the_spec_file_is_the_single_source_and_its_example_is_a_valid_lease(self):
        self.assertEqual((SPEC["spec"], SPEC["version"], SPEC["key"]), ("ui-qa-harness-lock", 1, "locks/ui-harness.json"))
        self.assertEqual(SPEC["leaseFields"], ["owner", "runId", "acquiredAt", "expiresAt"])
        ex = SPEC["exampleLease"]
        self.assertEqual(sorted(ex), sorted(SPEC["leaseFields"]))
        self.assertEqual(valid_lease(json.dumps(ex)), ex)
        self.assertEqual(parse(ex["expiresAt"]) - parse(ex["acquiredAt"]), SPEC["ttlSeconds"])
        self.assertLess(SPEC["renewEverySeconds"] * 2, SPEC["ttlSeconds"])  # one missed beat still leaves the lease
        self.assertEqual(fmt(parse(ex["acquiredAt"])), ex["acquiredAt"])  # the time format round-trips

    def test_what_is_not_a_lease(self):
        for bad in (b"", b"[]", b"{}", json.dumps({**SPEC["exampleLease"], "expiresAt": "tomorrow"}).encode(),
                    json.dumps({k: v for k, v in SPEC["exampleLease"].items() if k != "runId"}).encode()):
            self.assertIsNone(valid_lease(bad), bad)


class HarnessLockTest(unittest.TestCase):
    def lock(self, s3, clock, run="run-b", owner="ci:2"):
        return HarnessLock(s3, "bucket", owner, run, clock=clock, sleep=clock.sleep)

    def test_acquire_on_a_free_harness_writes_a_full_lease(self):
        s3, clock = FakeS3Lease(), Clock()
        lk = self.lock(s3, clock)
        lk.acquire(0)
        lease = s3.lease()
        self.assertEqual((lease["owner"], lease["runId"]), ("ci:2", "run-b"))
        self.assertEqual(parse(lease["expiresAt"]) - clock(), SPEC["ttlSeconds"])
        self.assertEqual(lk.etag, s3.objects[SPEC["key"]][1])

    def test_a_held_lease_waits_then_reports_busy_and_writes_nothing(self):
        s3, clock = FakeS3Lease(), Clock()
        self.lock(s3, clock, run="run-a", owner="ci:1").acquire(0)
        before = s3.objects[SPEC["key"]]
        with self.assertRaises(LockBusy) as cm:
            self.lock(s3, clock).acquire(120)
        self.assertIn("ci:1", str(cm.exception))
        self.assertEqual(s3.objects[SPEC["key"]], before)
        self.assertEqual(clock.sleeps, 120 // SPEC["pollSeconds"])

    def test_a_lease_freed_during_the_wait_is_taken(self):
        s3, clock = FakeS3Lease(), Clock()
        a = self.lock(s3, clock, run="run-a")
        a.acquire(0)
        b = self.lock(s3, clock)
        orig = clock.sleep
        def sleep_and_release(sec):
            orig(sec)
            a.release()
        clock.sleep = sleep_and_release
        b.sleep = sleep_and_release
        b.acquire(600)
        self.assertEqual(s3.lease()["runId"], "run-b")

    def test_an_expired_lease_is_taken_over_only_past_the_skew(self):
        s3, clock = FakeS3Lease(), Clock()
        self.lock(s3, clock, run="run-a").acquire(0)
        clock.t += SPEC["ttlSeconds"] + SPEC["clockSkewSeconds"] - 1  # expired, but within the skew: still held
        with self.assertRaises(LockBusy):
            self.lock(s3, clock).acquire(0)
        clock.t += 1
        self.lock(s3, clock).acquire(0)
        self.assertEqual(s3.lease()["runId"], "run-b")

    def test_an_unreadable_lease_is_taken_over(self):
        s3, clock = FakeS3Lease(), Clock()
        s3.put_object(Bucket="bucket", Key=SPEC["key"], Body=b"not json")
        self.lock(s3, clock).acquire(0)
        self.assertEqual(s3.lease()["runId"], "run-b")

    def test_two_takers_of_one_expired_lease_one_wins(self):
        s3, clock = FakeS3Lease(), Clock()
        self.lock(s3, clock, run="run-a").acquire(0)
        clock.t += SPEC["ttlSeconds"] + SPEC["clockSkewSeconds"]
        b, c = self.lock(s3, clock, run="run-b"), self.lock(s3, clock, run="run-c")
        real_read = HarnessLock._read
        def stale_read(lk):  # c read the expired lease before b took it over
            return real_read(lk) if lk is b else (valid_lease(json.dumps({**SPEC["exampleLease"], "expiresAt": "2000-01-01T00:00:00Z"})), stale)
        stale = s3.objects[SPEC["key"]][1]
        b.acquire(0)
        c._read = lambda: stale_read(c)
        with self.assertRaises(LockBusy):
            c.acquire(0)
        self.assertEqual(s3.lease()["runId"], "run-b")

    def test_renew_extends_and_a_taken_over_lease_is_lost(self):
        s3, clock = FakeS3Lease(), Clock()
        a = self.lock(s3, clock, run="run-a")
        a.acquire(0)
        clock.t += 100
        self.assertTrue(a.renew())
        self.assertEqual(parse(s3.lease()["expiresAt"]) - clock(), SPEC["ttlSeconds"])
        clock.t += SPEC["ttlSeconds"] + SPEC["clockSkewSeconds"]
        self.lock(s3, clock).acquire(0)  # run-b takes the expired lease over
        self.assertFalse(a.renew())
        self.assertTrue(a.lost)
        self.assertEqual(s3.lease()["runId"], "run-b")

    def test_release_deletes_only_our_own_lease(self):
        s3, clock = FakeS3Lease(), Clock()
        a = self.lock(s3, clock, run="run-a")
        a.acquire(0)
        clock.t += SPEC["ttlSeconds"] + SPEC["clockSkewSeconds"]
        self.lock(s3, clock).acquire(0)
        self.assertFalse(a.release())                 # run-b's lease stays
        self.assertEqual(s3.lease()["runId"], "run-b")
        s3b = FakeS3Lease(); own = self.lock(s3b, clock); own.acquire(0)
        self.assertTrue(own.release())
        self.assertIsNone(s3b.lease())

    def test_other_s3_errors_fail_closed(self):
        class Denied(FakeS3Lease):
            def put_object(self, **kw):
                raise S3Error("AccessDenied", 403)
        with self.assertRaises(S3Error):
            self.lock(Denied(), Clock()).acquire(0)

    def test_the_heartbeat_renews_while_a_pass_streams(self):
        s3, clock = FakeS3Lease(), Clock()
        lk = HarnessLock(s3, "bucket", "ci:2", "run-b", clock=clock, sleep=clock.sleep, renew_every=0.01)
        lk.acquire(0)
        lk.start_heartbeat()
        try:
            deadline = time.time() + 2
            while s3.events.count(("put", "ok")) < 3 and time.time() < deadline:
                time.sleep(0.01)
        finally:
            lk.stop_heartbeat()
        self.assertGreaterEqual(s3.events.count(("put", "ok")), 3)  # 1 acquire + at least 2 renewals
        self.assertFalse(lk.lost)


class HarnessLockReviewFixesTest(unittest.TestCase):
    """The commander's review of feature-53: a failing heartbeat, acquiredAt, and the 412-then-404 race."""
    def test_a_heartbeat_failing_past_the_ttl_marks_the_lease_lost(self):
        class Throttled(FakeS3Lease):
            def put_object(self, **kw):
                if "IfMatch" in kw:
                    raise S3Error("SlowDown", 503)  # not a 412: the lease is not known to be lost
                return super().put_object(**kw)
        s3, clock = Throttled(), Clock()
        lk = HarnessLock(s3, "bucket", "ci:2", "run-b", clock=clock, sleep=clock.sleep)
        lk.acquire(0)
        clock.t += SPEC["ttlSeconds"] - SPEC["clockSkewSeconds"] - 1
        self.assertTrue(lk.beat_once())          # still inside the lease: keep trying
        clock.t += 1
        self.assertFalse(lk.beat_once())         # no renewal for ttl - skew: another run may hold it now
        self.assertTrue(lk.lost)

    def test_a_successful_renewal_restarts_the_clock(self):
        s3, clock = FakeS3Lease(), Clock()
        lk = HarnessLock(s3, "bucket", "ci:2", "run-b", clock=clock, sleep=clock.sleep)
        lk.acquire(0)
        for _ in range(5):
            clock.t += SPEC["renewEverySeconds"]
            self.assertTrue(lk.beat_once())
        self.assertFalse(lk.is_lost())

    def test_renewal_keeps_acquired_at(self):
        s3, clock = FakeS3Lease(), Clock()
        lk = HarnessLock(s3, "bucket", "ci:2", "run-b", clock=clock, sleep=clock.sleep)
        lk.acquire(0)
        first = s3.lease()["acquiredAt"]
        clock.t += SPEC["renewEverySeconds"]
        lk.renew()
        self.assertEqual(s3.lease()["acquiredAt"], first)
        self.assertEqual(parse(s3.lease()["expiresAt"]) - clock(), SPEC["ttlSeconds"])

    def test_a_holder_releasing_between_our_412_and_our_read_is_retried_at_once(self):
        class Racy(FakeS3Lease):
            raced = False
            def put_object(self, **kw):
                if kw.get("IfNoneMatch") == "*" and not self.raced:
                    self.raced = True  # the holder's lease existed for our create, and was released before our read
                    raise S3Error("PreconditionFailed", 412)
                return super().put_object(**kw)
        s3, clock = Racy(), Clock()
        HarnessLock(s3, "bucket", "ci:2", "run-b", clock=clock, sleep=clock.sleep).acquire(600)
        self.assertEqual((s3.lease()["runId"], clock.sleeps), ("run-b", 0))


class LeaseStateFileTest(unittest.TestCase):
    """The state file the renewer writes and qa_agent.py reads (spec: etagOwnership)."""
    def setUp(self):
        self.path = os.path.join(tempfile.mkdtemp(), "lease.json")
        self.clock = Clock()

    def state(self, **over):
        st = {"runId": "run-1", "etag": '"e1"', "acquiredAt": fmt(self.clock.t - 60),
              "lastRenewedAt": fmt(self.clock.t - 10), "lost": False, "pid": 0}
        st.update(over)
        return st

    def test_write_then_read_round_trips_only_the_state_fields(self):
        harness_lock.write_state(self.path, {**self.state(), "extra": "dropped"})
        self.assertEqual(harness_lock.read_state(self.path), self.state())
        self.assertEqual(os.listdir(os.path.dirname(self.path)), ["lease.json"])  # the temp file was renamed away

    def test_a_file_missing_a_field_is_not_a_state_file(self):
        with open(self.path, "w") as f:
            json.dump({k: v for k, v in self.state().items() if k != "etag"}, f)
        with self.assertRaises(ValueError):
            harness_lock.read_state(self.path)
        with open(self.path, "w") as f:
            json.dump([1], f)
        with self.assertRaises(ValueError):
            harness_lock.read_state(self.path)

    def test_lock_from_state_continues_the_lease_with_its_etag(self):
        s3 = FakeS3Lease()
        lk = HarnessLock(s3, "bucket", "ci:1", "run-1", clock=self.clock, sleep=self.clock.sleep)
        lk.acquire(0)
        acquired = lk.acquired_at
        st = self.state(etag=lk.etag, acquiredAt=fmt(acquired), lastRenewedAt=fmt(lk.last_renewed_at))
        again = harness_lock.lock_from_state(s3, "bucket", st, clock=self.clock, sleep=self.clock.sleep)
        self.assertEqual((again.run_id, again.etag, again.lost, again.acquired_at), ("run-1", lk.etag, False, acquired))
        self.clock.t += SPEC["renewEverySeconds"]
        self.assertTrue(again.renew())
        self.assertEqual(s3.lease()["acquiredAt"], fmt(acquired))
        self.assertTrue(harness_lock.lock_from_state(s3, "bucket", self.state(lost=True), clock=self.clock).lost)


class HeldLeaseTest(unittest.TestCase):
    """qa_agent.py --lease-held: it only reads the state file, never S3."""
    def setUp(self):
        self.path = os.path.join(tempfile.mkdtemp(), "lease.json")
        self.clock = Clock()

    def write(self, renewed_ago=10, lost=False, run_id="run-1"):
        harness_lock.write_state(self.path, {"runId": run_id, "etag": '"e1"', "acquiredAt": fmt(self.clock.t - 600),
                                             "lastRenewedAt": fmt(self.clock.t - renewed_ago), "lost": lost, "pid": 0})

    def test_a_fresh_lease_for_this_run_has_no_problem(self):
        self.write()
        held = HeldLease(self.path, clock=self.clock)
        self.assertIsNone(held.problem("run-1"))
        self.assertFalse(held.is_lost())

    def test_problems(self):
        self.assertIn("no usable lease state", HeldLease(self.path, clock=self.clock).problem("run-1"))
        self.write(run_id="run-2")
        self.assertIn("not this run's", HeldLease(self.path, clock=self.clock).problem("run-1"))
        self.write(lost=True)
        self.assertIn("lost or stale", HeldLease(self.path, clock=self.clock).problem("run-1"))

    def test_stale_at_ttl_minus_skew_since_the_last_renewal(self):
        edge = SPEC["ttlSeconds"] - SPEC["clockSkewSeconds"]
        self.write(renewed_ago=edge - 1)
        self.assertFalse(HeldLease(self.path, clock=self.clock).is_lost())
        self.write(renewed_ago=edge)
        self.assertTrue(HeldLease(self.path, clock=self.clock).is_lost())

    def test_once_lost_stays_lost_and_an_unreadable_file_is_lost(self):
        self.write(lost=True)
        held = HeldLease(self.path, clock=self.clock)
        self.assertTrue(held.is_lost())
        self.write()
        self.assertTrue(held.is_lost())
        with open(self.path, "w") as f:
            f.write("{")
        self.assertTrue(HeldLease(self.path, clock=self.clock).is_lost())

    def test_it_never_renews_or_releases(self):
        self.write()
        held = HeldLease(self.path, clock=self.clock)
        held.start_heartbeat(); held.stop_heartbeat()
        self.assertFalse(held.release())
        self.assertTrue(os.path.exists(self.path))


if __name__ == "__main__":
    unittest.main()
