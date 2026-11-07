#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-jupyter kernel bridge.

A tiny JSON-lines RPC shim between the dsh host process (Node) and a real
Jupyter kernel. Node spawns this script (`python -u bridge.py`), writes one
JSON command per line on stdin, and reads one JSON event per line on stdout.
The bridge owns the jupyter_client KernelManager, so all ZeroMQ protocol
handling stays in the Python ecosystem — no native ZMQ bindings in Node.

Commands (one JSON object per line on stdin):
  {"op": "status"}                          -> {"type": "status_reply", "alive": bool}
  {"op": "execute", "cell_id": str, "code": str, "exec_id": str}
  {"op": "interrupt"}
  {"op": "restart", "id": n}                -> {"type": "ready", "op_id": n}
  {"op": "shutdown"}                        -> clean shutdown, then exit(0)

Events (one JSON object per line on stdout):
  {"type": "ready", "kernel_name": ..., "language_info": {...}}  # op_id echoed
                                                 after a requested restart
  {"type": "status_reply", "alive": bool}
  {"type": "status", "execution_state": "busy"|"idle", "cell_id": ...}
  {"type": "stream", "cell_id": ..., "name": "stdout"|"stderr", "text": ...}
  {"type": "display_data", "cell_id": ..., "data": {...}, "metadata": {...}}
  {"type": "update_display_data", "cell_id": ..., "data": {...}, "metadata": {...}}
  {"type": "execute_result", "cell_id": ..., "data": {...}, "execution_count": N}
  {"type": "error", "cell_id": ..., "ename": ..., "evalue": ..., "traceback": [...]}
  {"type": "clear_output", "cell_id": ..., "wait": bool}
  {"type": "execute_reply", "cell_id": ..., "ok": bool, "execution_count": N,
   "kernel_restarted": bool}  # present after an interrupt-timeout restart attempt
  # Incomplete output also emits an error and marks execute_reply with
  # ok=false and output_incomplete=true; a successful shell reply is not enough.
  {"type": "kernel_died", "message": ...}
  {"type": "log", "level": "info"|"error"|"warn", "message": ...}

Every event produced by one execution (status/stream/display_data/
update_display_data/execute_result/error/clear_output/execute_reply, plus a
kernel_died that belongs to it) echoes the exec_id supplied with that execute
command, so the host can discard events from a superseded run after restart.
ready/status_reply/log events carry no exec_id.

Executions are serialized: a second execute while one is in flight is queued
and run after the first completes (Jupyter kernels execute one request at a
time anyway).

Derived from @dong-victor/dsh-better-sidebar-jupyter python/bridge.py
(MIT License, Copyright (c) dong-victor). Modifications for dsh-bsb-ipynb:
optional --cwd/--kernel-name flags and the DSH_IPYNB_KERNEL_CWD environment
variable. See ../NOTICE for attribution.
"""

import argparse
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import traceback

try:
    # Keep stdio byte-exact UTF-8 regardless of the Windows console codepage.
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def emit(event):
    """Write one event line to stdout, atomically flushed."""
    try:
        sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        pass

def log(level, message):
    emit({"type": "log", "level": level, "message": str(message)})


# Windows: hold a kill-on-close Job Object for the bridge's lifetime. Any hard
# termination of the bridge (TerminateProcess, host crash) then reaps the
# ipykernel and every process the user's cells spawned, instead of leaving
# orphans behind.
_WINDOWS_JOB_HANDLE = None


def adopt_windows_job():
    """Put this process in a kill-on-close Job Object (Windows only)."""
    global _WINDOWS_JOB_HANDLE
    if os.name != "nt" or _WINDOWS_JOB_HANDLE is not None:
        return
    try:
        import ctypes

        class BasicLimit(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", ctypes.c_uint32),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", ctypes.c_uint32),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", ctypes.c_uint32),
                ("SchedulingClass", ctypes.c_uint32),
            ]

        class IoCounters(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class ExtendedLimit(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BasicLimit),
                ("IoInfo", IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = ctypes.c_void_p
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
        kernel32.SetInformationJobObject.restype = ctypes.c_int
        kernel32.SetInformationJobObject.argtypes = [
            ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32,
        ]
        kernel32.AssignProcessToJobObject.restype = ctypes.c_int
        kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]

        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return
        info = ExtendedLimit()
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(
            job, 9, ctypes.byref(info), ctypes.sizeof(info),
        ):
            kernel32.CloseHandle(job)
            return
        if not kernel32.AssignProcessToJobObject(job, kernel32.GetCurrentProcess()):
            kernel32.CloseHandle(job)
            return
        _WINDOWS_JOB_HANDLE = job
    except Exception as error:
        log("warn", "could not adopt Windows job object: %s" % (error,))


class Bridge:
    def __init__(self, cwd=None, kernel_name=None, connection_file=None):
        self.cwd = cwd or None
        self.kernel_name = kernel_name or None
        # Host-chosen connection file. Supplying it lets the host delete the
        # file even when this bridge is killed with TerminateProcess.
        self.connection_file = connection_file or None
        self.km = None          # KernelManager
        self.kc = None          # BlockingKernelClient
        self.pending = {}       # shell msg_id -> (cell_id, exec_id)
        self.idle_events = {}   # shell msg_id -> threading.Event (iopub idle seen)
        # Sending an execute request and registering its ID share this lock
        # with IOPub lookup, so even the earliest output needs no extra cache.
        # Reentrant on purpose: the SIGTERM/SIGINT handler runs on the main
        # thread, which may already hold this lock inside restart/shutdown, and
        # its deterministic cleanup must not deadlock against itself.
        self.pending_lock = threading.RLock()
        self.exec_queue = queue.Queue()   # (cell_id, exec_id, code)
        self.stop = threading.Event()
        self.executor = None
        self.interrupt_requested_at = None
        self.restarting = False           # True while a restart is in flight
        # Restarts are serialized: concurrent callers share one restart and
        # wait for the same completion instead of racing the kernel manager.
        self.restart_guard = threading.Lock()
        self.restart_inflight = None      # {"done": Event, "result": bool} while set

    # ------------------------------------------------------------- kernel

    def emit_ready(self, op_id=None):
        """Report a ready kernel, echoing the restart operation it completes."""
        event = {
            "type": "ready",
            "kernel_name": getattr(self.km, "kernel_name", "python3") or "python3",
            "language_info": {},
        }
        if op_id is not None:
            event["op_id"] = op_id
        emit(event)

    def start_kernel(self, cwd=None):
        from jupyter_client import KernelManager
        from jupyter_client.kernelspec import KernelSpec, KernelSpecManager

        class SelectedPythonSpecManager(KernelSpecManager):
            def get_kernel_spec(self, kernel_name):
                # The host selected the interpreter that launched this bridge.
                # Keep its invocation path: realpath would discard venv identity.
                # A registered spec may point at another Python or add its own
                # environment/provisioner, so supply our own in-memory spec.
                return KernelSpec(
                    name=kernel_name,
                    display_name="Python (selected interpreter)",
                    language="python",
                    argv=[sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
                    env={},
                    metadata={
                        "kernel_provisioner": {
                            "provisioner_name": "local-provisioner",
                            "config": {},
                        },
                    },
                )

        # Restart reuses this manager and its controlled spec. No kernelspec is
        # installed on disk, and an optional kernel name is only a label.
        manager_kwargs = {
            "kernel_name": self.kernel_name or "python3",
            "kernel_spec_manager": SelectedPythonSpecManager(),
        }
        if self.connection_file:
            manager_kwargs["connection_file"] = self.connection_file
        km = KernelManager(**manager_kwargs)
        # Publish the references before anything starts so every failure path
        # (and a SIGTERM during bootstrap) can deterministically clean up.
        self.km = km
        try:
            # Redirect the kernel's own stdio away from the bridge's pipes so
            # kernel chatter can never pollute the JSON-lines protocol.
            km.start_kernel(cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            kc = km.client()
            self.kc = kc
            kc.start_channels()
            # Keep this below the host's 30s ready timeout: self-report a
            # kernel_died instead of being SIGTERM'd mid-bootstrap (which
            # would orphan the kernel process).
            kc.wait_for_ready(timeout=25)
        except Exception as error:
            log("error", "kernel start failed: %s" % (error,))
            self.shutdown_kernel()
            raise
        self.emit_ready()
        log("info", "kernel ready")

    def clear_pending_locked(self):
        """Release in-flight idle waits and mappings; caller holds pending_lock."""
        for event in self.idle_events.values():
            event.set()
        self.pending.clear()
        self.idle_events.clear()

    def shutdown_kernel(self):
        with self.pending_lock:
            self.stop.set()
            self.clear_pending_locked()
        try:
            if self.kc is not None:
                self.kc.stop_channels()
        except Exception:
            pass
        try:
            if self.km is not None:
                self.km.shutdown_kernel(now=True)
        except Exception:
            pass
        # Remove the connection file even when jupyter_client never recorded
        # writing it (failed startup, killed kernel), then release the refs so a
        # failed restart cannot leave the IOPub pump on a dead client.
        if self.connection_file:
            try:
                os.remove(self.connection_file)
            except OSError:
                pass
        try:
            if self.km is not None:
                self.km.cleanup_connection_file()
        except Exception:
            pass
        self.kc = None
        self.km = None

    def terminate(self, _signum=None, _frame=None):
        """Clean up the kernel deterministically, then leave without unwinding.

        The host escalates to SIGTERM when the bridge cannot answer an
        operation (for example while a slow restart blocks the command loop).
        The kernel must still get the same cleanup as an explicit shutdown
        instead of relying on ipykernel's parent poller, which leaves the
        jupyter_client connection file behind.
        """
        try:
            self.shutdown_kernel()
        finally:
            os._exit(0)

    def install_signal_handlers(self):
        """Route SIGTERM/SIGINT through terminate() where the platform allows."""
        for name in ("SIGTERM", "SIGINT"):
            number = getattr(signal, name, None)
            if number is None:
                continue
            try:
                signal.signal(number, self.terminate)
            except (ValueError, OSError):
                # Signal handlers can only be installed from the main thread.
                pass

    # ----------------------------------------------------------- execution

    def execute(self, cell_id, exec_id, code):
        """Queue one cell for execution; the executor thread runs it."""
        self.exec_queue.put((cell_id, exec_id, code))

    def executor_loop(self):
        """Run queued executions serially; read shell replies."""
        while not self.stop.is_set():
            try:
                cell_id, exec_id, code = self.exec_queue.get(timeout=0.3)
            except queue.Empty:
                continue
            except Exception:
                continue
            if self.stop.is_set():
                break
            try:
                self.run_one(cell_id, exec_id, code)
            except Exception as error:
                emit({
                    "type": "error",
                    "cell_id": cell_id,
                    "exec_id": exec_id,
                    "ename": type(error).__name__,
                    "evalue": str(error),
                    "traceback": traceback.format_exception(type(error), error, error.__traceback__),
                })
                emit({
                    "type": "execute_reply",
                    "cell_id": cell_id,
                    "exec_id": exec_id,
                    "ok": False,
                    "execution_count": None,
                })

    def run_one(self, cell_id, exec_id, code):
        kc = self.kc
        self.interrupt_requested_at = None
        finished = False
        msg_id = None
        idle = None

        def finish(status, error=None, execution_count=None, kernel_restarted=None,
                   output_incomplete=False):
            nonlocal finished
            if finished:
                return
            finished = True
            event = {
                "type": "execute_reply",
                "cell_id": cell_id,
                "exec_id": exec_id,
                "ok": status == "ok",
                "execution_count": execution_count,
                "status": status,
                "error": error,
            }
            if kernel_restarted is not None:
                event["kernel_restarted"] = kernel_restarted
            if output_incomplete:
                event["output_incomplete"] = True
            emit(event)

        try:
            if kc is None or not kc.is_alive():
                emit({
                    "type": "kernel_died",
                    "cell_id": cell_id,
                    "exec_id": exec_id,
                    "message": "kernel is not running",
                })
                finish("error", "kernel is not running")
                return
            # allow_stdin=False is deliberate: this bridge never forwards stdin
            # requests to the host, so input()/getpass must fail fast with
            # StdinNotImplementedError instead of blocking forever.
            with self.pending_lock:
                if self.stop.is_set() or self.restarting or kc is not self.kc:
                    raise RuntimeError("kernel changed before execution could be submitted")
                # execute() defaults to reply=False: it only sends the request
                # and returns its ID, without waiting for shell/IOPub replies.
                # Hold the lock until registration so the pump cannot mistake
                # early output for an unknown request. Never wait for execution
                # or emit output while holding this lock.
                msg_id = kc.execute(code, silent=False, store_history=True, allow_stdin=False)
                self.pending[msg_id] = (cell_id, exec_id)
                idle = threading.Event()
                self.idle_events[msg_id] = idle
            # The shell reply closes the request; iopub events arrive in the
            # iopub pump thread while we block here. Hold the execute_reply
            # until the pump has seen the matching idle status, so the reply
            # never overtakes the cell's own outputs (stream/display/error).
            reply = None
            while not self.stop.is_set():
                # Another restart (host request or a previous interrupt
                # timeout) can replace the kernel while this cell is waiting
                # for its shell reply. Never block forever on a superseded
                # client: report the interrupted cell instead.
                if kc is not self.kc or self.restarting:
                    finish("interrupted", "kernel changed before the cell finished")
                    return
                try:
                    candidate = kc.get_shell_msg(timeout=1)
                except queue.Empty:
                    # ipykernel's interrupt handling is a no-op on Windows
                    # ("Interrupt message not supported on Windows"), so a
                    # running cell may never answer an interrupt. If the user
                    # asked for an interrupt and the kernel has been silent
                    # past the grace period, restart the kernel so the session
                    # cannot hang.
                    if self.interrupt_requested_at is not None:
                        waited = time.monotonic() - self.interrupt_requested_at
                        if waited > 3:
                            restarted = self.restart()
                            message = (
                                "interrupt timed out; kernel restarted"
                                if restarted
                                else "interrupt timed out; kernel restart failed"
                            )
                            finish("interrupted", message, kernel_restarted=restarted)
                            return
                    continue
                except Exception as error:
                    log("error", "shell reply lost: %s" % (error,))
                    finish("error", "shell reply lost: %s" % (error,))
                    return
                # Match the reply to THIS request: the shell socket can carry
                # stale messages (e.g. the kernel_info_reply that
                # wait_for_ready leaves behind), which would otherwise
                # misattribute every reply by one slot.
                parent = candidate.get("parent_header", {}).get("msg_id")
                if parent == msg_id:
                    reply = candidate
                    break
                log("warn", "discarding stale shell message %s" % (
                    candidate.get("header", {}).get("msg_type"),
                ))
            if reply is None:
                finish("error", "kernel stopped before the cell finished")
                return
            idle_seen = idle.wait(timeout=10)
            content = reply.get("content", {})
            with self.pending_lock:
                stopped = self.stop.is_set()
                # Control operations set idle events to wake their waiters,
                # then clear their mappings under this same lock. Check the
                # registered Event identity as well as client/request identity:
                # even a completed or failed restart cannot impersonate idle.
                current = (
                    not stopped and not self.restarting and kc is self.kc
                    and self.pending.get(msg_id) == (cell_id, exec_id)
                    and self.idle_events.get(msg_id) is idle
                )
            if not idle_seen or not current:
                if not current:
                    reason = "Kernel stopped" if stopped else "Kernel restarted or changed"
                    reason += " before output delivery completed; output may be incomplete"
                    ename = "KernelInterrupted"
                    status = "interrupted"
                else:
                    reason = "Timed out waiting for IOPub idle after 10 seconds; output may be incomplete"
                    ename = "IOPubTimeout"
                    status = "error"
                emit({
                    "type": "error", "cell_id": cell_id, "exec_id": exec_id,
                    "ename": ename, "evalue": reason, "traceback": [],
                })
                finish(status, reason, content.get("execution_count"), output_incomplete=True)
                return
            status = content.get("status", "error")
            finish(status, content.get("ename") or None, content.get("execution_count"))
        except Exception as error:
            emit({
                "type": "error",
                "cell_id": cell_id,
                "exec_id": exec_id,
                "ename": type(error).__name__,
                "evalue": str(error),
                "traceback": traceback.format_exception(type(error), error, error.__traceback__),
            })
            finish("error", str(error))
        finally:
            if msg_id is not None:
                with self.pending_lock:
                    if self.idle_events.get(msg_id) is idle:
                        self.pending.pop(msg_id, None)
                        self.idle_events.pop(msg_id, None)
            self.interrupt_requested_at = None

    # -------------------------------------------------------------- iopub

    def iopub_loop(self):
        """Pump kernel iopub messages and forward them as events."""
        failures = 0
        while not self.stop.is_set():
            kc = self.kc
            if kc is None:
                # Wait for the kernel to come up before pumping.
                threading.Event().wait(0.1)
                continue
            if not kc.is_alive():
                if self.restarting:
                    # The kernel is being restarted: the old client is dead but
                    # a fresh one is on its way — wait it out and keep pumping
                    # instead of tearing the whole bridge down.
                    while self.restarting and not self.stop.is_set():
                        threading.Event().wait(0.2)
                    continue
                emit({"type": "kernel_died", "message": "kernel process exited"})
                with self.pending_lock:
                    self.stop.set()
                    self.clear_pending_locked()
                # The kernel is gone and the bridge has no way to pump its
                # replacement: exit so the host observes EOF and can forget
                # this entry instead of keeping a zombie process around.
                self.shutdown_kernel()
                os._exit(0)
            try:
                msg = kc.get_iopub_msg(timeout=0.25)
                failures = 0
            except queue.Empty:
                failures = 0
                continue
            except Exception as error:
                if self.stop.is_set():
                    break
                # A dead client must not turn into a busy loop: back off
                # between attempts and eventually report a bounded failure.
                failures += 1
                if failures == 1 or failures % 10 == 0:
                    log("warn", "iopub read failed (%d): %s" % (failures, error))
                if failures >= 10:
                    emit({"type": "kernel_died", "message": "kernel iopub channel failed repeatedly"})
                    with self.pending_lock:
                        self.stop.set()
                        self.clear_pending_locked()
                    self.shutdown_kernel()
                    os._exit(0)
                time.sleep(min(0.02 * failures, 0.2))
                continue
            try:
                self.handle_iopub(msg)
            except Exception as error:
                log("error", "iopub handling failed: %s" % (error,))

    def handle_iopub(self, msg):
        header = msg.get("header", {})
        parent = msg.get("parent_header", {})
        msg_type = header.get("msg_type", "")
        parent_id = parent.get("msg_id")
        with self.pending_lock:
            mapping = self.pending.get(parent_id)
        if mapping is None:
            # Completed executions may keep emitting from background threads.
            # They will never be registered again: neither retain their output
            # nor forward it untagged into an unrelated execution.
            return
        cell_id, exec_id = mapping
        content = msg.get("content", {})
        if msg_type == "status":
            state = content.get("execution_state", "idle")
            emit({
                "type": "status",
                "execution_state": state,
                "cell_id": cell_id,
                "exec_id": exec_id,
            })
            if state == "idle":
                with self.pending_lock:
                    event = self.idle_events.get(parent.get("msg_id"))
                    if event is not None:
                        event.set()
        elif msg_type == "stream":
            emit({
                "type": "stream",
                "cell_id": cell_id,
                "exec_id": exec_id,
                "name": content.get("name", "stdout"),
                "text": content.get("text", ""),
            })
        elif msg_type == "display_data":
            transient = content.get("transient") or {}
            emit({
                "type": "display_data",
                "cell_id": cell_id,
                "exec_id": exec_id,
                "data": content.get("data", {}),
                "metadata": content.get("metadata", {}),
                "display_id": transient.get("display_id"),
            })
        elif msg_type == "update_display_data":
            transient = content.get("transient") or {}
            emit({
                "type": "update_display_data",
                "cell_id": cell_id,
                "exec_id": exec_id,
                "data": content.get("data", {}),
                "metadata": content.get("metadata", {}),
                "display_id": transient.get("display_id"),
            })
        elif msg_type == "execute_result":
            emit({
                "type": "execute_result",
                "cell_id": cell_id,
                "exec_id": exec_id,
                "data": content.get("data", {}),
                "execution_count": content.get("execution_count"),
                "metadata": content.get("metadata", {}),
            })
        elif msg_type == "error":
            emit({
                "type": "error",
                "cell_id": cell_id,
                "exec_id": exec_id,
                "ename": content.get("ename", "Error"),
                "evalue": content.get("evalue", ""),
                "traceback": content.get("traceback", []),
            })
        elif msg_type == "clear_output":
            emit({
                "type": "clear_output",
                "cell_id": cell_id,
                "exec_id": exec_id,
                "wait": bool(content.get("wait", False)),
            })

    # ------------------------------------------------------------ control

    def drain_queue(self, status="interrupted"):
        """Drop every queued (not yet started) execution, replying ok=false for
        each so a client waiting on a run-all batch settles instead of hanging.
        The cell currently executing is NOT touched — the caller decides what
        to do with it (interrupt grace / restart)."""
        dropped = []
        while True:
            try:
                dropped.append(self.exec_queue.get_nowait())
            except queue.Empty:
                break
        for cell_id, exec_id, _code in dropped:
            emit({
                "type": "execute_reply",
                "cell_id": cell_id,
                "exec_id": exec_id,
                "ok": False,
                "execution_count": None,
                "status": status,
                "error": "cancelled",
            })
        if dropped:
            log("info", "dropped %d queued execution(s)" % len(dropped))

    def interrupt(self):
        if self.km is None or self.kc is None:
            log("warn", "no kernel to interrupt")
            return
        if self.interrupt_requested_at is None:
            self.interrupt_requested_at = time.monotonic()
        # Drop cells queued behind the running one: an interrupt cancels the
        # whole batch, not just the head (the client sends run-all as one
        # batch so the bridge owns the queue across browser reconnects).
        self.drain_queue("interrupted")
        try:
            # Control-channel interrupt_request (message mode): on Windows this
            # is a documented no-op inside ipykernel ("Interrupt message not
            # supported on Windows"), so run_one() force-restarts the kernel
            # when the interrupted cell stays silent past the grace period.
            msg = self.kc.session.msg("interrupt_request", content={})
            self.kc.control_channel.send(msg)
            log("info", "interrupt sent")
        except Exception as error:
            log("error", "interrupt failed: %s" % (error,))

    def restart(self, op_id=None):
        """Restart the kernel once, sharing an in-flight restart.

        The bridge allows only one restart at a time: a caller that finds one
        already running waits for it and then reports its own operation id so
        the host can match the ready event it is waiting for.
        """
        if self.km is None or self.kc is None:
            log("warn", "no kernel to restart")
            return False
        with self.restart_guard:
            holder = self.restart_inflight
            if holder is None:
                holder = {"done": threading.Event(), "result": False}
                self.restart_inflight = holder
                leader = True
            else:
                leader = False
        if not leader:
            holder["done"].wait()
            if holder["result"] and op_id is not None:
                self.emit_ready(op_id)
            return holder["result"]
        try:
            result = self.restart_once(op_id)
            holder["result"] = result
            return result
        finally:
            with self.restart_guard:
                if self.restart_inflight is holder:
                    self.restart_inflight = None
            holder["done"].set()

    def restart_failed(self, message):
        """Tear down deterministically after a restart that cannot complete.

        Leaving the old (stopped) client in ``self.kc`` while a fresh kernel is
        alive makes the IOPub pump fail on every iteration; clearing the refs
        and shutting the kernel down gives the host one deterministic
        ``kernel_died`` instead of a busy loop and a silent 30s ready timeout.
        """
        was_stopping = self.stop.is_set()
        self.shutdown_kernel()
        if not was_stopping:
            emit({"type": "kernel_died", "message": message})

    def restart_once(self, op_id=None):
        # Same batch semantics: a restart cancels cells queued behind the
        # running one (they would otherwise execute after the fresh kernel).
        if self.stop.is_set() or self.km is None or self.kc is None:
            log("warn", "no kernel to restart")
            return False
        self.drain_queue("restarted")
        with self.pending_lock:
            self.restarting = True
            self.clear_pending_locked()
        try:
            try:
                self.kc.stop_channels()
            except Exception:
                pass
            try:
                self.km.restart_kernel(now=True)
            except Exception as error:
                log("error", "restart failed: %s" % (error,))
                self.restart_failed("kernel restart failed: %s" % (error,))
                return False
            kc = None
            try:
                # jupyter_client channel threads cannot be restarted on the same
                # client ("threads can only be started once"), so create a fresh
                # client against the restarted kernel. The iopub/executor loops
                # re-read self.kc every iteration, so the swap is safe.
                kc = self.km.client()
                kc.start_channels()
                kc.wait_for_ready(timeout=25)
            except Exception as error:
                log("error", "restart channels failed: %s" % (error,))
                try:
                    if kc is not None:
                        kc.stop_channels()
                except Exception:
                    pass
                self.restart_failed("kernel restart failed: %s" % (error,))
                return False
            if self.stop.is_set():
                # A shutdown raced the restart: never publish a client after
                # the deterministic cleanup already ran.
                try:
                    kc.stop_channels()
                except Exception:
                    pass
                return False
            with self.pending_lock:
                self.kc = kc
                # Clear the flag before announcing readiness: the host submits
                # the next execution as soon as it sees 'ready', and run_one()
                # rejects submissions while a restart is marked in flight.
                self.restarting = False
            self.interrupt_requested_at = None
            self.emit_ready(op_id)
            log("info", "kernel restarted")
            return True
        finally:
            with self.pending_lock:
                self.restarting = False

    # ------------------------------------------------------------- main

    def restart_in_background(self, op_id=None):
        """Run one restart away from the command-loop thread (may block ~25 s)."""
        try:
            self.restart(op_id)
        except Exception as error:
            log("error", "background restart failed: %s" % (error,))

    def handle_command(self, command):
        """Handle one parsed command; return False when the bridge should exit."""
        op = command.get("op")
        try:
            if op == "status":
                alive = self.km is not None and self.kc is not None and self.kc.is_alive()
                emit({"type": "status_reply", "alive": bool(alive)})
            elif op == "execute":
                self.execute(
                    command.get("cell_id") or "",
                    command.get("exec_id"),
                    command.get("code") or "",
                )
            elif op == "interrupt":
                self.interrupt()
            elif op == "restart":
                # A restart can block for up to wait_for_ready(25); running it
                # inside this loop would stop status/interrupt/shutdown from
                # being read during that window.
                threading.Thread(
                    target=self.restart_in_background,
                    args=(command.get("id"),),
                    daemon=True,
                ).start()
            elif op == "shutdown":
                self.shutdown_kernel()
                return False
            else:
                log("warn", "unknown op: %r" % (op,))
        except Exception as error:
            log("error", "op %s failed: %s" % (op, error))
        return True

    def command_loop(self):
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            try:
                command = json.loads(line)
            except Exception:
                log("error", "invalid command line: %r" % (line[:200],))
                continue
            if not isinstance(command, dict):
                log("error", "invalid command: expected JSON object")
                continue
            if not self.handle_command(command):
                return

    def run(self):
        adopt_windows_job()
        self.install_signal_handlers()
        cwd = (
            self.cwd
            or os.environ.get("DSH_IPYNB_KERNEL_CWD")
            or os.environ.get("DSH_JUPYTER_KERNEL_CWD")
            or None
        )
        try:
            self.start_kernel(cwd=cwd)
        except Exception as error:
            emit({
                "type": "kernel_died",
                "message": "kernel failed to start: %s" % (error,),
            })
            return 1
        self.executor = threading.Thread(target=self.executor_loop, daemon=True)
        self.executor.start()
        pump = threading.Thread(target=self.iopub_loop, daemon=True)
        pump.start()
        try:
            self.command_loop()
        finally:
            self.shutdown_kernel()
        return 0


def main():
    parser = argparse.ArgumentParser(description="dsh-bsb-ipynb kernel bridge")
    parser.add_argument("--cwd", default=None, help="working directory for the kernel")
    parser.add_argument(
        "--kernel-name", default=None,
        help="kernel label (always launches this Python interpreter)",
    )
    parser.add_argument(
        "--connection-file", default=None,
        help="connection file path chosen by the host so it survives a hard kill",
    )
    args = parser.parse_args()
    bridge = Bridge(
        cwd=args.cwd,
        kernel_name=args.kernel_name,
        connection_file=args.connection_file,
    )
    code = bridge.run()
    sys.exit(code)


if __name__ == "__main__":
    main()
