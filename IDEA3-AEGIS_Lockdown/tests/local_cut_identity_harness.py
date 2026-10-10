"""Self-checking multi-identity harness for the local CUT channel. Run only via test_local_cut_identities.py.

It runs inside an unprivileged user namespace (``unshare --user --map-users=auto --map-groups=auto --map-root-user``) so that
REAL distinct uid/gid identities exist without any privilege on the host: Core 1500, operator 2000, other 3000, transport gid
2500. The real gate, server, credential and client are used; the supervisor is a counting fake (the real supervisor is covered
by test_local_cut.py). Nothing touches a broker, device, relay or the repository. Exit status 0 means every check held.
"""

import json
import os
import shutil
import socket
import stat
import sys
import tempfile
import time

sys.path.insert(0, sys.argv[1])
from aegis_soc import local_cut, local_restore as lr  # noqa: E402
from aegis_soc.controller import CommandResult  # noqa: E402
import pwd, grp, threading  # noqa: E402,F401  (preload before privileges are dropped)

CORE, OPER, OTHER, TGID = 1500, 2000, 3000, 2500
REASON = "attacker confirmed on the LAN; isolate now"
SECRET = "a long per-cut operator secret 7731"
FAILURES = []


def check(name, condition, detail=""):
    if not condition:
        FAILURES.append(f"{name}: {detail}")


def drop(uid, gid, groups):
    os.setgroups(groups)
    os.setresgid(gid, gid, gid)
    os.setresuid(uid, uid, uid)


def run_as(uid, gid, groups, fn, timeout=20):
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(r)
        try:
            drop(uid, gid, groups)
            out = {"euid": os.geteuid(), "res": fn()}
        except BaseException as error:  # noqa: BLE001
            out = {"error": f"{type(error).__name__}: {error}"}
        os.write(w, json.dumps(out, default=str).encode())
        os._exit(0)
    os.close(w)
    data = b""
    end = time.time() + timeout
    while time.time() < end:
        chunk = os.read(r, 65536)
        if not chunk:
            break
        data += chunk
    os.waitpid(pid, 0)
    return json.loads(data or b"{}")


class Sup:
    """Counting stand-in for the supervisor: the first CUT is dispatched (hook first), later ones are pending."""

    def __init__(self):
        self.calls = 0
        self.protocol = None

    def issue_command(self, action, description, **kwargs):
        self.calls += 1
        if self.calls == 1:
            kwargs["pre_publish"]({"msg_id": "ab" * 16, "seq": 1})
            return CommandResult(action, True, True, False, "ab" * 16, "SENT", seq=1)
        return CommandResult(action, False, False, False, None, "pending", reason_code="COMMAND_PENDING")


def start_core(path, stop_r, res_w, ready_w, credential):
    pid = os.fork()
    if pid:
        return pid
    out = {}
    try:
        drop(CORE, CORE, [TGID])
        os.umask(0o077)
        sup = Sup()
        strict, events = [], []
        gate = local_cut.LocalCutGate(
            sup, allowed_uid=OPER, credential=credential,
            audit=lambda *a, **k: events.append(a), audit_strict=lambda *a, **k: strict.append(a[0]),
        )
        server = local_cut.LocalCutServer(path, gate, socket_gid=TGID)
        server.start()
        st = os.lstat(path)
        out["sock"] = {"mode": stat.S_IMODE(st.st_mode), "uid": st.st_uid, "gid": st.st_gid}
        os.write(ready_w, b"1")
        os.read(stop_r, 1)
        out["supervisor_calls"] = sup.calls
        out["pre_dispatch_rows"] = len(strict)
        out["leaked_secret"] = SECRET in json.dumps([events, strict], default=str)
        server.close()
    except BaseException as error:  # noqa: BLE001
        out["error"] = f"{type(error).__name__}: {error}"
        try:
            os.write(ready_w, b"0")
        except OSError:
            pass
    os.write(res_w, json.dumps(out).encode())
    os._exit(0)


def probe(path):
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(3)
    try:
        s.connect(path)
        return "CONNECTED"
    except OSError as error:
        return f"errno{error.errno}"
    finally:
        s.close()


def attempt(path, secret=SECRET, core_uid=CORE):
    controller = local_cut.LocalCutController(path, core_uid=core_uid, secret_provider=lambda: secret)
    result = controller.issue("CUT_UPLINK", REASON)
    return {"ok": result.ok, "sent": result.sent, "reason": result.reason_code}


def scenario_dir(base, name, mode, owner=CORE):
    d = os.path.join(base, name)
    os.mkdir(d)
    os.chown(d, owner, TGID)
    os.chmod(d, mode)
    return d, os.path.join(d, "cut.sock")


def main():
    credential = lr.RestoreCredential.parse(local_cut.hash_cut_secret(SECRET))
    base = tempfile.mkdtemp(prefix="aegis-cutid-", dir="/tmp")
    os.chmod(base, 0o755)
    try:
        d, path = scenario_dir(base, "s1", 0o750)
        stop_r, stop_w = os.pipe()
        res_r, res_w = os.pipe()
        rd_r, rd_w = os.pipe()
        core = start_core(path, stop_r, res_w, rd_w, credential)
        check("core starts", os.read(rd_r, 1) == b"1")

        wrong = run_as(OPER, OPER, [TGID], lambda: attempt(path, secret="not the operator secret at all"))
        check("wrong secret refused", wrong["res"]["reason"] == "AUTH_FAILED", wrong)
        none = run_as(OPER, OPER, [TGID], lambda: attempt(path, secret=None))
        check("no secret refused locally", none["res"]["reason"] == "AUTH_REQUIRED", none)
        # Correct uid, correct group, correct secret from the OTHER uid: closed at accept, no reply, no dispatch.
        other_good = run_as(OTHER, OTHER, [TGID], lambda: attempt(path))
        check("other uid with correct secret refused", other_good["res"]["sent"] is False
              and other_good["res"]["reason"] == "OUTCOME_UNKNOWN", other_good)
        good = run_as(OPER, OPER, [TGID], lambda: attempt(path))
        check("operator + secret dispatched", good["res"]["sent"] is True, good)
        again = run_as(OPER, OPER, [TGID], lambda: attempt(path))
        check("second CUT refused as pending", again["res"]["reason"] == "COMMAND_PENDING", again)
        nogroup = run_as(OPER, OPER, [], lambda: probe(path))
        check("operator without transport group cannot connect", nogroup["res"] == "errno13", nogroup)
        other_nogroup = run_as(OTHER, OTHER, [], lambda: probe(path))
        check("other without group cannot connect", other_nogroup["res"] == "errno13", other_nogroup)
        impostor = run_as(OPER, OPER, [TGID], lambda: attempt(path, core_uid=CORE + 1))
        check("client refuses wrong server uid", impostor["res"]["reason"] == "CHANNEL_UNAVAILABLE", impostor)

        # I3: a non-operator group member holds a connection open; the operator is not delayed.
        stall = os.fork()
        if stall == 0:
            drop(OTHER, OTHER, [TGID])
            s = socket.socket(socket.AF_UNIX)
            s.connect(path)
            s.sendall(b'{"v": 1')
            time.sleep(8)
            os._exit(0)
        time.sleep(0.5)
        started = time.time()
        during = run_as(OPER, OPER, [TGID], lambda: attempt(path))
        latency = time.time() - started
        check("operator not delayed by a stalled non-operator", latency < 1.5, f"{latency:.2f}s")
        check("operator answered while stalled", during["res"]["reason"] == "COMMAND_PENDING", during)
        # The unauthorized stalled connection was closed by the server without reading: its recv returns EOF immediately.
        eof = run_as(OTHER, OTHER, [TGID], lambda: (lambda s: (s.connect(path), s.settimeout(2), s.recv(1))[2])(
            socket.socket(socket.AF_UNIX)).decode() == "")
        check("unauthorized connection closed without a read", eof["res"] is True, eof)
        os.kill(stall, 9)
        os.waitpid(stall, 0)

        os.write(stop_w, b"x")
        result = json.loads(os.read(res_r, 65536) or b"{}")
        os.waitpid(core, 0)
        check("socket mode/owner", result.get("sock") == {"mode": 0o660, "uid": CORE, "gid": TGID}, result.get("sock"))
        check("exactly one dispatch", result.get("pre_dispatch_rows") == 1, result)
        check("secret never audited", result.get("leaked_secret") is False, result)
        check("lost replies are not retried", result.get("supervisor_calls") == 3, result)

        # directory contract
        for name, mode, owner, expected in (("grpw", 0o770, CORE, "not group/world writable"),
                                            ("foreign", 0o750, OTHER, "not group/world writable")):
            d, path = scenario_dir(base, name, mode, owner)
            stop_r, stop_w = os.pipe()
            res_r, res_w = os.pipe()
            rd_r, rd_w = os.pipe()
            core = start_core(path, stop_r, res_w, rd_w, credential)
            ready = os.read(rd_r, 1)
            out = json.loads(os.read(res_r, 65536) or b"{}")
            os.waitpid(core, 0)
            check(f"{name} directory refused", ready == b"0" and expected in out.get("error", ""), out)
        missing = os.path.join(base, "nodir", "cut.sock")
        stop_r, stop_w = os.pipe()
        res_r, res_w = os.pipe()
        rd_r, rd_w = os.pipe()
        core = start_core(missing, stop_r, res_w, rd_w, credential)
        ready = os.read(rd_r, 1)
        out = json.loads(os.read(res_r, 65536) or b"{}")
        os.waitpid(core, 0)
        check("missing directory refused and not created", ready == b"0" and not os.path.exists(os.path.dirname(missing)), out)
    finally:
        shutil.rmtree(base, ignore_errors=True)
    print(json.dumps({"failures": FAILURES}))
    sys.exit(1 if FAILURES else 0)


main()
