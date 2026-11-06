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
  {"op": "execute", "cell_id": str, "code": str}
  {"op": "interrupt"}
  {"op": "restart"}
  {"op": "shutdown"}                        -> clean shutdown, then exit(0)

Events (one JSON object per line on stdout):
  {"type": "ready", "kernel_name": ..., "language_info": {...}}
  {"type": "status_reply", "alive": bool}
  {"type": "status", "execution_state": "busy"|"idle", "cell_id": ...}
  {"type": "stream", "cell_id": ..., "name": "stdout"|"stderr", "text": ...}
  {"type": "display_data", "cell_id": ..., "data": {...}, "metadata": {...}}
  {"type": "update_display_data", "cell_id": ..., "data": {...}, "metadata": {...}}
  {"type": "execute_result", "cell_id": ..., "data": {...}, "execution_count": N}
  {"type": "error", "cell_id": ..., "ename": ..., "evalue": ..., "traceback": [...]}
  {"type": "clear_output", "cell_id": ..., "wait": bool}
  {"type": "execute_reply", "cell_id": ..., "ok": bool, "execution_count": N}
  {"type": "kernel_died", "message": ...}
  {"type": "log", "level": "info"|"error"|"warn", "message": ...}

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


class Bridge:
    def __init__(self, cwd=None, kernel_name=None):
        self.cwd = cwd or None
        self.kernel_name = kernel_name or None
        self.km = None          # KernelManager
        self.kc = None          # BlockingKernelClient
        self.pending = {}       # shell msg_id -> cell_id
        self.idle_events = {}   # shell msg_id -> threading.Event (iopub idle seen)
        # iopub can beat the shell reply that tells us msg_id -> cell_id.
        # Buffer a bounded number of those messages and replay them once the
        # mapping is registered, so their output is not lost or misattributed.
        self.early_iopub = {}   # msg_id -> [raw iopub message]
        self.early_idle = set() # msg_ids whose idle status arrived early
        self.executing = False
        self.pending_lock = threading.Lock()
        self.exec_queue = queue.Queue()   # (cell_id, code)
        self.stop = threading.Event()
        self.executor = None
        self.interrupt_requested_at = None
        self.restarting = False           # True while a restart is in flight

    # ------------------------------------------------------------- kernel

    def start_kernel(self, cwd=None):
        from jupyter_client import KernelManager
        from jupyter_client.kernelspec import KernelSpecManager

        km = KernelManager(kernel_name=self.kernel_name) if self.kernel_name else KernelManager()
        try:
            # Redirect the kernel's own stdio away from the bridge's pipes so
            # kernel chatter can never pollute the JSON-lines protocol.
            km.start_kernel(cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as error:
            emit({
                "type": "log",
                "level": "error",
                "message": "kernel start failed: %s" % (error,),
            })
            raise
        kc = km.client()
        kc.start_channels()
        try:
            kc.wait_for_ready(timeout=90)
        except Exception as error:
            km.shutdown_kernel(now=True)
            raise
        self.km = km
        self.kc = kc
        try:
            info = kc.kernel_info()
            language_info = info.get("content", {}).get("language_info", {})
        except Exception:
            language_info = {}
        emit({
            "type": "ready",
            "kernel_name": getattr(km, "kernel_name", "python3") or "python3",
            "language_info": language_info,
        })
        log("info", "kernel ready")

    def shutdown_kernel(self):
        self.stop.set()
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

    # ----------------------------------------------------------- execution

    def execute(self, cell_id, code):
        """Queue one cell for execution; the executor thread runs it."""
        self.exec_queue.put((cell_id, code))

    def executor_loop(self):
        """Run queued executions serially; read shell replies."""
        while not self.stop.is_set():
            try:
                cell_id, code = self.exec_queue.get(timeout=0.3)
            except queue.Empty:
                continue
            except Exception:
                continue
            if self.stop.is_set():
                break
            try:
                self.run_one(cell_id, code)
            except Exception as error:
                emit({
                    "type": "error",
                    "cell_id": cell_id,
                    "ename": type(error).__name__,
                    "evalue": str(error),
                    "traceback": traceback.format_exception(type(error), error, error.__traceback__),
                })
                emit({
                    "type": "execute_reply",
                    "cell_id": cell_id,
                    "ok": False,
                    "execution_count": None,
                })

    def run_one(self, cell_id, code):
        kc = self.kc
        self.interrupt_requested_at = None
        self.executing = True
        finished = False
        msg_id = None

        def finish(status, error=None, execution_count=None):
            nonlocal finished
            if finished:
                return
            finished = True
            emit({
                "type": "execute_reply",
                "cell_id": cell_id,
                "ok": status == "ok",
                "execution_count": execution_count,
                "status": status,
                "error": error,
            })

        try:
            if kc is None or not kc.is_alive():
                emit({
                    "type": "kernel_died",
                    "cell_id": cell_id,
                    "message": "kernel is not running",
                })
                finish("error", "kernel is not running")
                return
            msg_id = kc.execute(code, silent=False, store_history=True)
            with self.pending_lock:
                self.pending[msg_id] = cell_id
                idle = threading.Event()
                self.idle_events[msg_id] = idle
                early = self.early_iopub.pop(msg_id, [])
                if msg_id in self.early_idle:
                    self.early_idle.discard(msg_id)
                    idle.set()
            # Replay iopub events that raced the shell reply registration.
            for raw in early:
                self.handle_iopub(raw)
            # The shell reply closes the request; iopub events arrive in the
            # iopub pump thread while we block here. Hold the execute_reply
            # until the pump has seen the matching idle status, so the reply
            # never overtakes the cell's own outputs (stream/display/error).
            reply = None
            while not self.stop.is_set():
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
                            self.restart()
                            finish("interrupted", "interrupt timed out; kernel restarted")
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
            idle = self.idle_events.get(msg_id)
            if idle is not None:
                idle.wait(timeout=10)
            content = reply.get("content", {})
            status = content.get("status", "error")
            finish(status, content.get("ename") or None, content.get("execution_count"))
        except Exception as error:
            emit({
                "type": "error",
                "cell_id": cell_id,
                "ename": type(error).__name__,
                "evalue": str(error),
                "traceback": traceback.format_exception(type(error), error, error.__traceback__),
            })
            finish("error", str(error))
        finally:
            self.executing = False
            if msg_id is not None:
                with self.pending_lock:
                    self.pending.pop(msg_id, None)
                    self.idle_events.pop(msg_id, None)
            self.interrupt_requested_at = None

    # -------------------------------------------------------------- iopub

    def iopub_loop(self):
        """Pump kernel iopub messages and forward them as events."""
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
                    for event in self.idle_events.values():
                        event.set()
                self.stop.set()
                # The kernel is gone and the bridge has no way to pump its
                # replacement: exit so the host observes EOF and can forget
                # this entry instead of keeping a zombie process around.
                self.shutdown_kernel()
                os._exit(0)
            try:
                msg = kc.get_iopub_msg(timeout=0.25)
            except queue.Empty:
                continue
            except Exception:
                if self.stop.is_set():
                    break
                continue
            try:
                self.handle_iopub(msg)
            except Exception as error:
                log("error", "iopub handling failed: %s" % (error,))

    def handle_iopub(self, msg):
        header = msg.get("header", {})
        parent = msg.get("parent_header", {})
        msg_type = header.get("msg_type", "")
        cell_id = None
        parent_id = parent.get("msg_id")
        with self.pending_lock:
            cell_id = self.pending.get(parent_id)
        content = msg.get("content", {})
        if cell_id is None and self.executing and parent_id:
            # The shell reply has not registered this msg_id yet. Buffer the
            # message (bounded) and replay it from run_one once it can be
            # attributed to the cell that caused it.
            with self.pending_lock:
                if len(self.early_iopub) > 256:
                    self.early_iopub.clear()
                    self.early_idle.clear()
                self.early_iopub.setdefault(parent_id, []).append(msg)
                if msg_type == "status" and content.get("execution_state") == "idle":
                    self.early_idle.add(parent_id)
            return
        if msg_type == "status":
            state = content.get("execution_state", "idle")
            emit({
                "type": "status",
                "execution_state": state,
                "cell_id": cell_id,
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
                "name": content.get("name", "stdout"),
                "text": content.get("text", ""),
            })
        elif msg_type == "display_data":
            transient = content.get("transient") or {}
            emit({
                "type": "display_data",
                "cell_id": cell_id,
                "data": content.get("data", {}),
                "metadata": content.get("metadata", {}),
                "display_id": transient.get("display_id"),
            })
        elif msg_type == "update_display_data":
            transient = content.get("transient") or {}
            emit({
                "type": "update_display_data",
                "cell_id": cell_id,
                "data": content.get("data", {}),
                "metadata": content.get("metadata", {}),
                "display_id": transient.get("display_id"),
            })
        elif msg_type == "execute_result":
            emit({
                "type": "execute_result",
                "cell_id": cell_id,
                "data": content.get("data", {}),
                "execution_count": content.get("execution_count"),
                "metadata": content.get("metadata", {}),
            })
        elif msg_type == "error":
            emit({
                "type": "error",
                "cell_id": cell_id,
                "ename": content.get("ename", "Error"),
                "evalue": content.get("evalue", ""),
                "traceback": content.get("traceback", []),
            })
        elif msg_type == "clear_output":
            emit({
                "type": "clear_output",
                "cell_id": cell_id,
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
        for cell_id, _code in dropped:
            emit({
                "type": "execute_reply",
                "cell_id": cell_id,
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
            self.interrupt_requested_at = time.monotonic()
            log("info", "interrupt sent")
        except Exception as error:
            log("error", "interrupt failed: %s" % (error,))

    def restart(self):
        if self.km is None or self.kc is None:
            log("warn", "no kernel to restart")
            return
        # Same batch semantics: a restart cancels cells queued behind the
        # running one (they would otherwise execute after the fresh kernel).
        self.drain_queue("restarted")
        self.restarting = True
        try:
            try:
                self.kc.stop_channels()
            except Exception:
                pass
            try:
                self.km.restart_kernel(now=True)
            except Exception as error:
                log("error", "restart failed: %s" % (error,))
                return
            try:
                # jupyter_client channel threads cannot be restarted on the same
                # client ("threads can only be started once"), so create a fresh
                # client against the restarted kernel. The iopub/executor loops
                # re-read self.kc every iteration, so the swap is safe.
                kc = self.km.client()
                kc.start_channels()
                kc.wait_for_ready(timeout=60)
                self.kc = kc
                with self.pending_lock:
                    self.pending.clear()
                    self.idle_events.clear()
                self.interrupt_requested_at = None
                try:
                    info = kc.kernel_info()
                    language_info = info.get("content", {}).get("language_info", {})
                except Exception:
                    language_info = {}
                emit({
                    "type": "ready",
                    "kernel_name": getattr(self.km, "kernel_name", "python3") or "python3",
                    "language_info": language_info,
                })
                log("info", "kernel restarted")
            except Exception as error:
                log("error", "restart channels failed: %s" % (error,))
        finally:
            self.restarting = False

    # ------------------------------------------------------------- main

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
            op = command.get("op")
            try:
                if op == "status":
                    alive = self.km is not None and self.kc is not None and self.kc.is_alive()
                    emit({"type": "status_reply", "alive": bool(alive)})
                elif op == "execute":
                    self.execute(command.get("cell_id") or "", command.get("code") or "")
                elif op == "interrupt":
                    self.interrupt()
                elif op == "restart":
                    self.restart()
                elif op == "shutdown":
                    self.shutdown_kernel()
                    return
                else:
                    log("warn", "unknown op: %r" % (op,))
            except Exception as error:
                log("error", "op %s failed: %s" % (op, error))

    def run(self):
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
    parser.add_argument("--kernel-name", default=None, help="Jupyter kernel name")
    args = parser.parse_args()
    bridge = Bridge(cwd=args.cwd, kernel_name=args.kernel_name)
    code = bridge.run()
    sys.exit(code)


if __name__ == "__main__":
    main()
