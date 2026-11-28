"""One signed-in UI QA run at a time: an S3 lease over the shared UI harness and QA logins (feature-53).

The format and the rules are in harness_lock_spec.json, next to this file. The Ops Console's Run QA implements the
same spec, so read the rules from there, not from this docstring. In short: create with IfNoneMatch='*'; take over an
expired lease with IfMatch on the ETag you read; renew and release only with your own ETag.

Stdlib only (plus the boto3 S3 client passed in), so it imports with boto3 stubbed out.
"""
import calendar
import json
import os
import threading
import time

SPEC = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "harness_lock_spec.json"),
                      encoding="utf-8"))
_LOST_CODES = {"PreconditionFailed", "ConditionalRequestConflict", "NoSuchKey", "412", "409", "404"}


class LockBusy(Exception):
    """Another run holds the lease and the wait ran out. `holder` is the lease that was read (or None)."""
    def __init__(self, holder):
        self.holder = holder
        who = f"{holder.get('owner')} (run {holder.get('runId')}) until {holder.get('expiresAt')}" if holder else "unknown"
        super().__init__(f"held by {who}")


def fmt(ts: float) -> str:
    return time.strftime(SPEC["timeFormat"], time.gmtime(int(ts)))


def parse(s) -> float:
    return float(calendar.timegm(time.strptime(str(s), SPEC["timeFormat"])))


def _lost(e) -> bool:
    """True for the S3 answers the spec treats as 'someone else moved': 412, 409, 404."""
    r = getattr(e, "response", None) or {}
    code = str((r.get("Error") or {}).get("Code") or "")
    status = str((r.get("ResponseMetadata") or {}).get("HTTPStatusCode") or "")
    return code in _LOST_CODES or status in _LOST_CODES


def valid_lease(body):
    """The lease dict when `body` is one (all leaseFields, parseable times), else None."""
    try:
        lease = json.loads(body)
        if not isinstance(lease, dict) or any(k not in lease for k in SPEC["leaseFields"]):
            return None
        parse(lease["acquiredAt"]), parse(lease["expiresAt"])
        return lease
    except (ValueError, TypeError):
        return None


class HarnessLock:
    def __init__(self, s3, bucket: str, owner: str, run_id: str, clock=time.time, sleep=time.sleep,
                 renew_every=None):
        self.s3, self.bucket, self.owner, self.run_id = s3, bucket, owner, run_id
        self.clock, self.sleep = clock, sleep
        self.renew_every = renew_every or SPEC["renewEverySeconds"]
        self.key = SPEC["key"]
        self.etag = None
        self.lost = False
        self.acquired_at = None    # set at acquire/takeover; renewals keep it
        self.last_renewed_at = None  # the last successful write of our lease
        self._stop = threading.Event()
        self._thread = None

    def _lease(self, acquired_at: float, now: float) -> bytes:
        return json.dumps({"owner": self.owner, "runId": self.run_id, "acquiredAt": fmt(acquired_at),
                           "expiresAt": fmt(now + SPEC["ttlSeconds"])}).encode()

    def _put(self, acquired_at=None, **cond):
        now = self.clock()
        acquired_at = now if acquired_at is None else acquired_at
        r = self.s3.put_object(Bucket=self.bucket, Key=self.key, Body=self._lease(acquired_at, now),
                               ContentType=SPEC["contentType"], **cond)
        self.etag, self.acquired_at, self.last_renewed_at = r["ETag"], acquired_at, now

    def _read(self):
        """(lease or None, etag), or (None, None) when there is no object."""
        try:
            r = self.s3.get_object(Bucket=self.bucket, Key=self.key)
        except Exception as e:  # noqa: BLE001 — only 404 means "no lease"; anything else is a real failure
            if _lost(e):
                return None, None
            raise
        return valid_lease(r["Body"].read()), r["ETag"]

    def acquire(self, wait_seconds: float) -> None:
        """Hold the lease or raise LockBusy once wait_seconds have passed. Other S3 errors propagate (fail closed)."""
        deadline = self.clock() + wait_seconds
        holder = None
        quick = 0  # immediate retries when the holder released between our 412 and our read
        while True:
            try:
                self._put(IfNoneMatch="*")
                return
            except Exception as e:  # noqa: BLE001
                if not _lost(e):
                    raise
            holder, etag = self._read()
            if etag is None and quick < 3:
                quick += 1
                continue
            quick = 0
            if etag is not None and (holder is None or
                                     self.clock() >= parse(holder["expiresAt"]) + SPEC["clockSkewSeconds"]):
                try:
                    self._put(IfMatch=etag)  # take over the expired (or unreadable) lease; one taker wins
                    return
                except Exception as e:  # noqa: BLE001
                    if not _lost(e):
                        raise
            if self.clock() >= deadline:
                raise LockBusy(holder)
            self.sleep(SPEC["pollSeconds"])

    def renew(self) -> bool:
        """Extend the lease with our own ETag. False (and `lost`) when it is no longer ours."""
        if self.lost or self.etag is None:
            return False
        try:
            self._put(acquired_at=self.acquired_at, IfMatch=self.etag)
            return True
        except Exception as e:  # noqa: BLE001
            if _lost(e):
                self.lost = True
                return False
            raise

    def is_lost(self) -> bool:
        """Lost when an S3 answer said so (412/409/404), or when no renewal has succeeded for ttlSeconds - clockSkewSeconds:
        by then another run may already have taken the lease over, even if no 412 has reached us."""
        if not self.lost and self.last_renewed_at is not None and \
                self.clock() >= self.last_renewed_at + SPEC["ttlSeconds"] - SPEC["clockSkewSeconds"]:
            self.lost = True
        return self.lost

    def beat_once(self) -> bool:
        """One heartbeat: renew; a transient error is retried next beat, unless the lease has run out meanwhile.
        Returns False once the lease is lost."""
        try:
            self.renew()
        except Exception:  # noqa: BLE001 — throttling, a network error, AccessDenied: try again next beat
            pass
        return not self.is_lost()

    def _beat(self):
        while not self._stop.wait(self.renew_every):
            if not self.beat_once():
                return

    def start_heartbeat(self):
        self._thread = threading.Thread(target=self._beat, name="harness-lock-heartbeat", daemon=True)
        self._thread.start()

    def stop_heartbeat(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def release(self) -> bool:
        """Delete the lease only if it is still ours (IfMatch on our ETag). Never deletes someone else's."""
        if self.etag is None:
            return False
        try:  # a lost lease fails If-Match (412) and is left alone
            self.s3.delete_object(Bucket=self.bucket, Key=self.key, IfMatch=self.etag)
            self.etag = None
            return True
        except Exception as e:  # noqa: BLE001
            if _lost(e):
                self.lost = True
                return False
            raise


# ── The lease state file: how the workflow's renewer hands the lease to qa_agent.py (feature-53) ─────────────────────
# One process renews (harness_lock_cli.py's renewer), so one process holds the latest ETag (spec: etagOwnership). It
# writes that ETag, its last successful renewal and `lost` to a state file; qa_agent.py reads the file to check the
# lease before every signed-in step, and never writes to S3 itself.
STATE_FIELDS = ("runId", "etag", "acquiredAt", "lastRenewedAt", "lost", "pid")


def write_state(path: str, state: dict) -> None:
    """Atomic replace, so a reader never sees half a file."""
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({k: state.get(k) for k in STATE_FIELDS}, f)
    os.replace(tmp, path)


def read_state(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        state = json.load(f)
    if not isinstance(state, dict) or any(k not in state for k in STATE_FIELDS):
        raise ValueError(f"{path} is not a lease state file")
    return state


def lock_from_state(s3, bucket: str, state: dict, clock=time.time, sleep=time.sleep) -> "HarnessLock":
    """A HarnessLock that continues the lease the state file describes (the renewer's view)."""
    lk = HarnessLock(s3, bucket, "", state["runId"], clock=clock, sleep=sleep)
    lk.etag, lk.lost = state["etag"], bool(state["lost"])
    lk.acquired_at, lk.last_renewed_at = parse(state["acquiredAt"]), parse(state["lastRenewedAt"])
    return lk


class HeldLease:
    """The lease the workflow holds, as qa_agent.py sees it (--lease-held <state file>). It never renews or releases:
    the workflow's renewer does. is_lost() applies the same rules as HarnessLock.is_lost(), from the state file."""
    def __init__(self, path: str, clock=time.time):
        self.path, self.clock = path, clock
        self.lost = False

    def problem(self, run_id: str):
        """Why this run may not use the held lease, or None."""
        try:
            st = read_state(self.path)
        except (OSError, ValueError) as e:
            return f"no usable lease state at {self.path} ({type(e).__name__})"
        if st["runId"] != run_id:
            return f"the held lease is not this run's (it is {st['runId']!r}, this run is {run_id!r})"
        if self.is_lost():
            return "the held lease is lost or stale"
        return None

    def is_lost(self) -> bool:
        if self.lost:
            return True
        try:
            st = read_state(self.path)
            stale = self.clock() >= parse(st["lastRenewedAt"]) + SPEC["ttlSeconds"] - SPEC["clockSkewSeconds"]
            self.lost = bool(st["lost"]) or stale
        except (OSError, ValueError):
            self.lost = True
        return self.lost

    def start_heartbeat(self):
        pass

    def stop_heartbeat(self):
        pass

    def release(self) -> bool:
        return False  # the workflow's "Release the UI harness lease" step releases it
