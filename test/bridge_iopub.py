"""Behavioral IOPub regressions, driven by node:test without extra packages."""

import argparse
import gc
import importlib.util
import json
import queue
import tempfile
import threading
import time
import unittest
import weakref


class TrackedMessage(dict):
    """Weak references detect retained messages without knowing cache fields."""


def message(parent, kind="stream", **content):
    return TrackedMessage({
        "header": {"msg_type": kind},
        "parent_header": {"msg_id": parent} if parent is not None else {},
        "content": content or {"name": "stdout", "text": "OUTPUT"},
    })


class ControlledClient:
    def __init__(self, parent="current-request"):
        self.parent = parent
        self.execute_entered = threading.Event()
        self.execute_release = threading.Event()
        self.execute_release.set()
        self.shell_entered = threading.Event()
        self.shell_release = threading.Event()
        self.closed = threading.Event()
        self.execute_error = None
        self.shell_error = None

    def is_alive(self):
        return True

    def execute(self, *_args, **_kwargs):
        self.execute_entered.set()
        if not self.execute_release.wait(3):
            raise RuntimeError("test did not release execute")
        if self.execute_error:
            raise self.execute_error
        return self.parent

    def get_shell_msg(self, timeout=1):
        self.shell_entered.set()
        if not self.shell_release.wait(timeout):
            raise queue.Empty()
        if self.closed.is_set():
            raise RuntimeError("channels stopped")
        if self.shell_error:
            raise self.shell_error
        return {"parent_header": {"msg_id": self.parent},
                "content": {"status": "ok", "execution_count": 1}}

    def stop_channels(self):
        self.closed.set()
        self.shell_release.set()

    def start_channels(self):
        pass

    def wait_for_ready(self, timeout):
        pass


class SilentClient(ControlledClient):
    """A client whose shell socket never yields a reply."""

    def get_shell_msg(self, timeout=1):
        self.shell_entered.set()
        time.sleep(0.02)
        raise queue.Empty()


class ControlledManager:
    kernel_name = "python3"

    def __init__(self, next_client):
        self.next_client = next_client

    def restart_kernel(self, now):
        pass

    def shutdown_kernel(self, now):
        pass

    def client(self):
        return self.next_client


class IOPubTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.original_emit = bridge_module.emit
        bridge_module.emit = self.events.append
        self.bridge = bridge_module.Bridge()
        self.client = ControlledClient()
        self.bridge.kc = self.client
        self.bridge.km = ControlledManager(ControlledClient("replacement-request"))
        self.threads = []
        self.releases = []

    def tearDown(self):
        for event in self.releases:
            event.set()
        self.client.execute_release.set()
        self.client.stop_channels()
        self.bridge.shutdown_kernel()
        for thread in self.threads:
            thread.join(3)
        bridge_module.emit = self.original_emit

    def start_thread(self, target):
        thread = threading.Thread(target=target, daemon=True)
        self.threads.append(thread)
        thread.start()
        return thread

    def start_run(self):
        return self.start_thread(lambda: self.bridge.run_one("current-cell", "current-exec", "work"))

    def wait(self, event):
        self.assertTrue(event.wait(3), "controlled event was not reached")

    def join(self, thread):
        thread.join(3)
        self.assertFalse(thread.is_alive(), "execution did not finish")

    def unknown_messages(self, count=1000):
        refs = []
        for index in range(count):
            item = message("completed-request", text="STALE-%d" % index, name="stdout")
            refs.append(weakref.ref(item))
            self.bridge.handle_iopub(item)
        del item
        return refs

    def assert_not_retained(self, refs):
        gc.collect()
        self.assertEqual(sum(ref() is not None for ref in refs), 0,
                         "completed/unknown request output must not remain reachable through the bridge")

    def finish_run(self, run):
        self.bridge.handle_iopub(message(self.client.parent, "status", execution_state="idle"))
        self.client.shell_release.set()
        self.join(run)

    def test_unknown_output_is_discarded_while_another_request_runs(self):
        run = self.start_run()
        self.wait(self.client.shell_entered)
        refs = self.unknown_messages()
        self.assert_not_retained(refs)
        self.assertEqual(self.events, [], "old output must not be emitted untagged or assigned to the current cell")
        self.bridge.handle_iopub(message(self.client.parent, text="CURRENT", name="stdout"))
        self.finish_run(run)
        streams = [event for event in self.events if event["type"] == "stream"]
        self.assertEqual([(event["text"], event["cell_id"], event["exec_id"]) for event in streams],
                         [("CURRENT", "current-cell", "current-exec")])
        self.assertEqual(self.bridge.pending, {})
        self.assertEqual(self.bridge.idle_events, {})

    def test_unknown_or_missing_parent_is_not_forwarded_while_idle(self):
        for parent in ["completed-request", None]:
            for kind, content in [
                ("stream", {"text": "STALE"}),
                ("status", {"execution_state": "idle"}),
                ("clear_output", {"wait": True}),
                ("display_data", {"data": {"text/plain": "STALE"}}),
            ]:
                self.bridge.handle_iopub(message(parent, kind, **content))
        self.assertEqual(self.events, [])

    def test_messages_arriving_before_execute_returns_keep_order_and_precede_idle_and_reply(self):
        self.client.execute_release.clear()
        self.client.shell_release.set()
        first_attempt = threading.Event()
        first_handled = threading.Event()
        first_emitting = threading.Event()
        release_first = threading.Event()
        second_emitted = threading.Event()
        self.releases.append(release_first)

        def capture(event):
            if event.get("text") == "FIRST":
                first_emitting.set()
                release_first.wait(3)
            self.events.append(event)
            if event.get("text") == "SECOND":
                second_emitted.set()

        bridge_module.emit = capture
        run = self.start_run()
        self.wait(self.client.execute_entered)

        def pump():
            first_attempt.set()
            self.bridge.handle_iopub(message(self.client.parent, text="FIRST", name="stdout"))
            first_handled.set()
            first_emitting.wait(3)
            self.bridge.handle_iopub(message(self.client.parent, text="SECOND", name="stdout"))
            self.bridge.handle_iopub(message(self.client.parent, "status", execution_state="idle"))

        pump_thread = self.start_thread(pump)
        self.wait(first_attempt)
        # Give a pre-registration message the opportunity to reach the bridge;
        # it may correctly block there until execute supplies its request ID.
        first_handled.wait(0.05)
        self.client.execute_release.set()
        self.wait(first_emitting)
        second_emitted.wait(0.05)
        self.assertFalse(any(event["type"] == "execute_reply" for event in self.events))
        release_first.set()
        self.join(pump_thread)
        self.join(run)
        relevant = [event.get("text", event["type"]) for event in self.events]
        self.assertEqual(relevant, ["FIRST", "SECOND", "status", "execute_reply"])
        self.assertTrue(self.events[-1]["ok"])
        self.assertNotIn("error", self.events[-1], "successful replies omit the error field")
        for event in self.events:
            self.assertEqual(event["cell_id"], "current-cell")
            self.assertEqual(event["exec_id"], "current-exec")

    def test_shell_error_releases_request_and_drops_late_output(self):
        run = self.start_run()
        self.wait(self.client.shell_entered)
        refs = self.unknown_messages(100)
        self.client.shell_error = RuntimeError("controlled shell failure")
        self.client.shell_release.set()
        self.join(run)
        self.assert_not_retained(refs)
        self.assertEqual(self.bridge.pending, {})
        self.assertEqual(self.bridge.idle_events, {})
        before = len(self.events)
        self.bridge.handle_iopub(message(self.client.parent, text="TOO LATE"))
        self.assertEqual(len(self.events), before)
        self.assertFalse(next(event for event in self.events if event["type"] == "execute_reply")["ok"])

    def test_execute_error_does_not_leave_routing_state(self):
        self.client.execute_error = RuntimeError("controlled execute failure")
        run = self.start_run()
        self.join(run)
        self.assertEqual(self.bridge.pending, {})
        self.assertEqual(self.bridge.idle_events, {})
        before = len(self.events)
        self.bridge.handle_iopub(message(self.client.parent, text="TOO LATE"))
        self.assertEqual(len(self.events), before)
        self.assertFalse(next(event for event in self.events if event["type"] == "execute_reply")["ok"])

    def test_restart_clears_routing_and_releases_waiters(self):
        run = self.start_run()
        self.wait(self.client.shell_entered)
        refs = self.unknown_messages(100)
        self.assertTrue(self.bridge.restart())
        self.join(run)
        self.assert_not_retained(refs)
        self.assertEqual(self.bridge.pending, {})
        self.assertEqual(self.bridge.idle_events, {})
        before = len(self.events)
        self.bridge.handle_iopub(message(self.client.parent, text="AFTER RESTART"))
        self.assertEqual(len(self.events), before)

    def test_pending_lock_allows_reentrant_signal_cleanup(self):
        # SIGTERM/SIGINT handlers run on the main thread, which may already
        # hold pending_lock inside restart/shutdown. A plain Lock would
        # deadlock there instead of running the deterministic cleanup.
        with self.bridge.pending_lock:
            self.assertTrue(self.bridge.pending_lock.acquire(blocking=False))
            self.bridge.pending_lock.release()

    def test_shutdown_clears_routing_and_releases_waiters(self):
        run = self.start_run()
        self.wait(self.client.shell_entered)
        refs = self.unknown_messages(100)
        self.bridge.shutdown_kernel()
        self.join(run)
        self.assert_not_retained(refs)
        self.assertEqual(self.bridge.pending, {})
        self.assertEqual(self.bridge.idle_events, {})
        before = len(self.events)
        self.bridge.handle_iopub(message(self.client.parent, text="AFTER SHUTDOWN"))
        self.assertEqual(len(self.events), before)

    def assert_idle_wait_is_released(self, operation):
        run = self.start_run()
        self.wait(self.client.shell_entered)
        idle = self.bridge.idle_events[self.client.parent]
        entered_idle_wait = threading.Event()
        operation_complete = threading.Event()
        self.releases.append(operation_complete)
        original_wait = idle.wait

        def wait_for_idle(timeout=None):
            entered_idle_wait.set()
            result = original_wait(timeout)
            # Resume only after the control operation returns. In particular,
            # a fast/failed restart has already reset its transient flag.
            operation_complete.wait(3)
            return result

        idle.wait = wait_for_idle
        self.client.shell_release.set()
        self.wait(entered_idle_wait)
        try:
            operation()
            operation_complete.set()
            run.join(1)
            self.assertFalse(run.is_alive(), "control operation must release the in-flight idle wait immediately")
            self.assertEqual(self.bridge.pending, {})
            self.assertEqual(self.bridge.idle_events, {})
            replies = [event for event in self.events if event["type"] == "execute_reply"]
            self.assertEqual(len(replies), 1)
            self.assertFalse(replies[0]["ok"], "a control-triggered wakeup is not proof that output finished")
            self.assertEqual(replies[0]["status"], "interrupted")
            self.assertTrue(replies[0]["output_incomplete"])
            errors = [event for event in self.events if event["type"] == "error"]
            self.assertEqual(errors[-1]["ename"], "KernelInterrupted")
            self.assertIn("output may be incomplete", errors[-1]["evalue"])
            self.assertEqual(errors[-1]["cell_id"], "current-cell")
            self.assertEqual(errors[-1]["exec_id"], "current-exec")
        finally:
            operation_complete.set()
            idle.set()
            self.join(run)

    def test_restart_releases_an_execution_already_waiting_for_idle(self):
        self.assert_idle_wait_is_released(self.bridge.restart)

    def test_shutdown_releases_an_execution_already_waiting_for_idle(self):
        self.assert_idle_wait_is_released(self.bridge.shutdown_kernel)

    def test_failed_restart_tears_down_the_bridge_instead_of_busy_looping(self):
        def fail_restart(now):
            raise RuntimeError("controlled restart failure")

        shutdowns = []
        self.bridge.km.restart_kernel = fail_restart
        self.bridge.km.shutdown_kernel = lambda now: shutdowns.append(now)
        self.assert_idle_wait_is_released(self.bridge.restart)
        self.assertFalse(self.bridge.restarting)
        self.assertIsNone(self.bridge.kc, "a failed restart must release the dead client")
        self.assertIsNone(self.bridge.km, "a failed restart must shut the kernel down")
        self.assertEqual(shutdowns, [True])
        died = [event for event in self.events if event["type"] == "kernel_died"]
        self.assertEqual(len(died), 1, "the host must get one deterministic kernel_died")
        self.assertIn("restart failed", died[0]["message"])

    def test_idle_timeout_reports_incomplete_output_and_does_not_poison_the_next_run(self):
        run = self.start_run()
        self.wait(self.client.shell_entered)
        old_parent = self.client.parent
        idle = self.bridge.idle_events[old_parent]
        waits = []
        restarts = []

        def timeout_immediately(timeout=None):
            waits.append(timeout)
            return False

        idle.wait = timeout_immediately
        self.bridge.km.restart_kernel = lambda now: restarts.append(now)
        self.bridge.handle_iopub(message(old_parent, text="PARTIAL OUTPUT", name="stdout"))
        self.client.shell_release.set()
        self.join(run)
        self.assertEqual(waits, [10], "production timeout remains bounded at ten seconds")
        self.assertEqual(restarts, [], "an output timeout must not discard the user's kernel state")
        self.assertFalse(self.client.closed.is_set())
        self.assertEqual(self.bridge.pending, {})
        self.assertEqual(self.bridge.idle_events, {})
        replies = [event for event in self.events if event["type"] == "execute_reply"]
        self.assertEqual(len(replies), 1)
        self.assertFalse(replies[0]["ok"])
        self.assertEqual(replies[0]["status"], "error")
        self.assertTrue(replies[0]["output_incomplete"])
        self.assertIn("output may be incomplete", replies[0]["error"])
        errors = [event for event in self.events if event["type"] == "error"]
        self.assertEqual(errors[-1]["ename"], "IOPubTimeout")
        self.assertIn("output may be incomplete", errors[-1]["evalue"])
        self.assertEqual(errors[-1]["cell_id"], "current-cell")
        self.assertEqual(errors[-1]["exec_id"], "current-exec")
        self.assertLess(self.events.index(errors[-1]), self.events.index(replies[0]),
                        "the visible error must precede its failed terminal reply")

        # Continue on the same client/kernel, deliberately reusing the cell
        # and exec identifiers but issuing a new Jupyter parent message ID.
        self.client.parent = "next-request"
        self.client.shell_entered.clear()
        self.client.shell_release.clear()
        self.events.clear()
        next_run = self.start_run()
        self.wait(self.client.shell_entered)
        for kind, content in [
            ("stream", {"text": "LATE OLD OUTPUT", "name": "stdout"}),
            ("status", {"execution_state": "idle"}),
        ]:
            self.bridge.handle_iopub(message(old_parent, kind, **content))
        self.assertEqual(self.events, [], "late output/idle from the timeout must not affect the new run")
        self.assertFalse(self.bridge.idle_events[self.client.parent].is_set())
        self.bridge.handle_iopub(message(self.client.parent, text="CURRENT OUTPUT", name="stdout"))
        self.finish_run(next_run)
        self.assertTrue(self.events[-1]["ok"])
        self.assertNotIn("error", self.events[-1], "successful replies omit the error field")
        self.assertEqual([event.get("text", event["type"]) for event in self.events],
                         ["CURRENT OUTPUT", "status", "execute_reply"])

    def test_kernel_death_cannot_wake_an_idle_waiter_into_success(self):
        run = self.start_run()
        self.wait(self.client.shell_entered)
        idle = self.bridge.idle_events[self.client.parent]
        entered_idle = threading.Event()
        original_wait = idle.wait
        original_stop = self.bridge.stop.set
        original_exit = bridge_module.os._exit
        pump = None

        def wait_for_idle(timeout=None):
            entered_idle.set()
            return original_wait(timeout)

        def pending_lock_held():
            lock = self.bridge.pending_lock
            # RLock.locked() only exists on Python 3.14+; older versions expose
            # the current-thread ownership check as the private _is_owned().
            locked = getattr(lock, "locked", None)
            if callable(locked):
                return locked()
            is_owned = getattr(lock, "_is_owned", None)
            return is_owned() if callable(is_owned) else True

        def staged_stop():
            # If death wakes idle before publishing cancellation under the
            # routing lock, let that waiter take the next scheduling turn.
            if not pending_lock_held():
                run.join(0.2)
            original_stop()

        def exit_pump_only(_status):
            raise SystemExit()

        idle.wait = wait_for_idle
        self.client.shell_release.set()
        self.wait(entered_idle)
        try:
            self.bridge.stop.set = staged_stop
            bridge_module.os._exit = exit_pump_only
            self.client.is_alive = lambda: False
            pump = self.start_thread(self.bridge.iopub_loop)
            self.join(pump)
            self.join(run)
            replies = [event for event in self.events if event["type"] == "execute_reply"]
            self.assertEqual(len(replies), 1)
            self.assertFalse(replies[0]["ok"])
            self.assertTrue(replies[0]["output_incomplete"])
            self.assertEqual(self.bridge.pending, {})
            self.assertEqual(self.bridge.idle_events, {})
        finally:
            original_stop()
            idle.set()
            self.join(run)
            if pump is not None:
                self.join(pump)
            self.bridge.stop.set = original_stop
            bridge_module.os._exit = original_exit

    def test_shutdown_prevents_new_execution_registration(self):
        self.bridge.shutdown_kernel()
        # If submission is attempted, fail promptly rather than letting a
        # broken implementation wait on the closed test client.
        self.client.execute_error = RuntimeError("must not submit after shutdown")
        run = self.start_run()
        self.join(run)
        self.assertFalse(self.client.execute_entered.is_set())
        self.assertEqual(self.bridge.pending, {})
        self.assertEqual(self.bridge.idle_events, {})

    def test_restart_in_progress_prevents_new_execution_registration(self):
        self.bridge.restarting = True
        self.client.execute_error = RuntimeError("must not submit during restart")
        run = self.start_run()
        self.join(run)
        self.assertFalse(self.client.execute_entered.is_set())
        self.assertEqual(self.bridge.pending, {})
        self.assertEqual(self.bridge.idle_events, {})

    def test_interrupt_deadline_starts_before_send_and_survives_retries(self):
        self.client = SilentClient()
        self.bridge.kc = self.client
        bridge = self.bridge
        run = self.start_run()
        self.wait(self.client.shell_entered)
        clock = [10.0]
        attempts = []
        restarts = []
        original_monotonic = bridge_module.time.monotonic
        original_restart = bridge.restart

        class Session:
            def msg(self, _msg_type, content):
                return content

        class Control:
            def send(self, _msg):
                attempts.append((clock[0], bridge.interrupt_requested_at))
                if len(attempts) == 3:
                    raise RuntimeError("controlled interrupt failure")

        def restart():
            restarts.append(clock[0] - bridge.interrupt_requested_at)
            return True

        self.client.session = Session()
        self.client.control_channel = Control()
        bridge.restart = restart
        bridge_module.time.monotonic = lambda: clock[0]
        try:
            # The third send fails. All attempts must retain the first request's
            # deadline so the silent execution still reaches automatic recovery.
            for requested_at in (10.0, 11.0, 12.0):
                clock[0] = requested_at
                bridge.interrupt()
            clock[0] = 13.01
            self.join(run)
        finally:
            bridge_module.time.monotonic = original_monotonic
            bridge.restart = original_restart
        self.assertEqual([requested_at for requested_at, _deadline in attempts], [10.0, 11.0, 12.0])
        self.assertEqual([deadline for _requested_at, deadline in attempts], [10.0, 10.0, 10.0],
                         "the deadline must exist before send and never move on retries")
        self.assertEqual(len(restarts), 1)
        self.assertAlmostEqual(restarts[0], 3.01)
        replies = [event for event in self.events if event["type"] == "execute_reply"]
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0]["status"], "interrupted")
        self.assertTrue(replies[0]["kernel_restarted"])

    def test_interrupt_deadline_is_not_postponed_by_stale_shell_replies(self):
        clock = [10.0]
        restarts = []
        original_monotonic = bridge_module.time.monotonic
        original_restart = self.bridge.restart

        class Session:
            def msg(self, _msg_type, content):
                return content

        class Control:
            def send(self, _msg):
                pass

        class StaleClient(ControlledClient):
            def __init__(self):
                super().__init__()
                self.session = Session()
                self.control_channel = Control()
                self.release_stale = threading.Event()
                self.stale_replies = 0

            def get_shell_msg(self, timeout=1):
                if self.stale_replies == 0:
                    self.shell_entered.set()
                    if not self.release_stale.wait(3):
                        raise RuntimeError("test did not release stale replies")
                self.stale_replies += 1
                if self.stale_replies > 10:
                    # Let the unfixed implementation settle with the wrong reply
                    # instead of leaving an infinite test thread behind.
                    raise RuntimeError("stale replies bypassed the interrupt deadline")
                clock[0] += 1.0
                return {
                    "header": {"msg_type": "execute_reply"},
                    "parent_header": {"msg_id": "stale-request"},
                    "content": {"status": "ok", "execution_count": 1},
                }

        def restart():
            restarts.append(clock[0] - self.bridge.interrupt_requested_at)
            return True

        self.client = StaleClient()
        self.bridge.kc = self.client
        self.bridge.restart = restart
        self.releases.append(self.client.release_stale)
        bridge_module.time.monotonic = lambda: clock[0]
        try:
            run = self.start_run()
            self.wait(self.client.shell_entered)
            self.bridge.interrupt()
            self.client.release_stale.set()
            self.join(run)
        finally:
            self.client.release_stale.set()
            bridge_module.time.monotonic = original_monotonic
            self.bridge.restart = original_restart
        self.assertEqual(restarts, [4.0])
        self.assertEqual(self.client.stale_replies, 4,
                         "the deadline must win even though every shell poll returns stale output")
        replies = [event for event in self.events if event["type"] == "execute_reply"]
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0]["status"], "interrupted")
        self.assertEqual(replies[0]["error"], "interrupt timed out; kernel restarted")
        self.assertTrue(replies[0]["kernel_restarted"])
        self.assertEqual(self.bridge.pending, {})
        self.assertEqual(self.bridge.idle_events, {})

    def test_concurrent_restarts_share_one_restart_and_echo_operation_ids(self):
        entered = threading.Event()
        release = threading.Event()
        self.releases.append(release)
        restarted = []
        manager = ControlledManager(ControlledClient("replacement-request"))
        manager.restart_kernel = lambda now: (restarted.append(now), entered.set(), release.wait(3))
        self.bridge.km = manager
        # Observe the follower entering restart() while the leader is blocked
        # inside restart_kernel(), so the coalescing path is deterministic.
        follower_entered = threading.Event()
        original_guard = self.bridge.restart_guard

        class ObservedLock:
            def __enter__(self):
                original_guard.acquire()
                follower_entered.set()
                return self

            def __exit__(self, *exc_info):
                original_guard.release()
                return False

        self.bridge.restart_guard = ObservedLock()
        results = []

        def call(op_id):
            results.append((op_id, self.bridge.restart(op_id)))

        leader = self.start_thread(lambda: call(11))
        self.wait(entered)
        follower_entered.clear()
        follower = self.start_thread(lambda: call(22))
        self.wait(follower_entered)
        release.set()
        self.join(leader)
        self.join(follower)
        self.assertEqual(len(restarted), 1, "concurrent callers must share one kernel restart")
        self.assertEqual(sorted(results), [(11, True), (22, True)])
        ready = [event for event in self.events if event["type"] == "ready"]
        self.assertEqual(sorted(event.get("op_id") for event in ready), [11, 22],
                         "each caller's operation id is echoed exactly once")
        self.assertFalse(self.bridge.restarting)

    def test_restart_ready_echoes_only_requested_operation_ids(self):
        self.assertTrue(self.bridge.restart())
        ready = [event for event in self.events if event["type"] == "ready"]
        self.assertEqual(len(ready), 1)
        self.assertNotIn("op_id", ready[0],
                         "a bridge-initiated restart must not claim a host operation id")
        self.events.clear()
        self.assertTrue(self.bridge.restart(7))
        ready = [event for event in self.events if event["type"] == "ready"]
        self.assertEqual([event.get("op_id") for event in ready], [7])

    def assert_superseded_run_finishes(self, supersede):
        self.client = SilentClient()
        self.bridge.kc = self.client
        run = self.start_run()
        self.wait(self.client.shell_entered)
        supersede()
        self.join(run)
        replies = [event for event in self.events if event["type"] == "execute_reply"]
        self.assertEqual(len(replies), 1)
        self.assertFalse(replies[0]["ok"])
        self.assertEqual(replies[0]["status"], "interrupted")
        self.assertIn("kernel changed", replies[0]["error"])
        self.assertEqual(self.bridge.pending, {})
        self.assertEqual(self.bridge.idle_events, {})

    def test_run_finishes_when_its_client_was_replaced(self):
        try:
            self.assert_superseded_run_finishes(
                lambda: setattr(self.bridge, "kc", ControlledClient("other-client")))
        finally:
            self.bridge.kc = self.client

    def test_run_finishes_when_a_restart_is_in_flight(self):
        def mark_restarting():
            self.bridge.restarting = True
        try:
            self.assert_superseded_run_finishes(mark_restarting)
        finally:
            self.bridge.restarting = False

    def test_restarting_flag_is_cleared_before_ready_is_emitted(self):
        observed = []
        original_emit = bridge_module.emit

        def capture(event):
            if event.get("type") == "ready":
                observed.append(self.bridge.restarting)
            original_emit(event)

        bridge_module.emit = capture
        try:
            self.assertTrue(self.bridge.restart(3))
        finally:
            bridge_module.emit = original_emit
        self.assertEqual(observed, [False],
                         "the host may submit its next execution as soon as ready arrives")

    def test_restart_command_runs_off_the_command_loop(self):
        entered = threading.Event()
        release = threading.Event()
        done = threading.Event()
        self.releases.append(release)
        calls = []

        def restart(op_id=None):
            calls.append(op_id)
            entered.set()
            release.wait(3)
            done.set()
            return True

        self.bridge.restart = restart
        started = time.monotonic()
        self.assertTrue(self.bridge.handle_command({"op": "restart", "id": 42}))
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 0.5, "a slow restart must not block the command loop")
        self.wait(entered)
        release.set()
        self.wait(done)
        self.assertEqual(calls, [42])

    def test_status_and_shutdown_stay_responsive_during_a_restart(self):
        entered = threading.Event()
        release = threading.Event()
        self.releases.append(release)

        def restart(op_id=None):
            entered.set()
            release.wait(3)
            return True

        shutdown_calls = []
        self.bridge.restart = restart
        self.bridge.shutdown_kernel = lambda: shutdown_calls.append(True)
        self.assertTrue(self.bridge.handle_command({"op": "restart", "id": 1}))
        self.wait(entered)
        started = time.monotonic()
        self.assertTrue(self.bridge.handle_command({"op": "status"}))
        self.assertFalse(self.bridge.handle_command({"op": "shutdown"}), "shutdown must end the command loop")
        self.assertLess(time.monotonic() - started, 0.5,
                        "status/shutdown must stay responsive while a restart is in flight")
        self.assertEqual(shutdown_calls, [True])
        status = [event for event in self.events if event["type"] == "status_reply"]
        self.assertTrue(status, "status must be answered during a restart")
        self.assertIn("alive", status[-1])
        release.set()

    def test_iopub_restart_ignores_old_client_failures_and_recovers(self):
        class OldClient(ControlledClient):
            def __init__(self):
                super().__init__()
                self.read_failures = 0

            def is_alive(self):
                return True

            def get_iopub_msg(self, timeout=1):
                self.read_failures += 1
                raise RuntimeError("old client channels are stopped")

        class NewClient(ControlledClient):
            def __init__(self):
                super().__init__()
                self.ready_entered = threading.Event()
                self.release_ready = threading.Event()
                self.read_attempts = 0
                self.second_read = threading.Event()

            def wait_for_ready(self, timeout):
                self.ready_entered.set()
                if not self.release_ready.wait(3):
                    raise RuntimeError("test did not release replacement readiness")

            def get_iopub_msg(self, timeout=1):
                self.read_attempts += 1
                if self.read_attempts == 1:
                    # A new client starts with a clean failure budget too.
                    raise RuntimeError("first replacement read fails")
                if self.read_attempts == 2:
                    self.second_read.set()
                time.sleep(0.01)
                raise queue.Empty()

        old = OldClient()
        new = NewClient()
        self.client = old
        self.bridge.kc = old
        self.bridge.km = ControlledManager(new)
        exits = []
        restart_results = []
        original_exit = bridge_module.os._exit
        bridge_module.os._exit = lambda status: exits.append(status)
        pump = None
        restart = None
        try:
            restart = self.start_thread(lambda: restart_results.append(self.bridge.restart(31)))
            self.wait(new.ready_entered)
            pump = self.start_thread(self.bridge.iopub_loop)
            deadline = time.monotonic() + 5
            while old.read_failures <= 10 and not exits and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(exits, [], "old client failures must not terminate a restarting bridge")
            self.assertGreater(old.read_failures, 10,
                               "the old client must remain in bounded backoff, not accumulate fatal failures")
            self.assertTrue(pump.is_alive())
            self.assertTrue(restart.is_alive())
            self.assertTrue(self.bridge.restarting)
            self.assertFalse(self.bridge.stop.is_set())
            self.assertFalse(any(event.get("type") == "kernel_died" for event in self.events))

            new.release_ready.set()
            self.join(restart)
            self.wait(new.second_read)
            self.assertEqual(restart_results, [True])
            self.assertIs(self.bridge.kc, new)
            self.assertEqual(exits, [])
            self.assertFalse(any(event.get("type") == "kernel_died" for event in self.events))
            ready = [event for event in self.events if event.get("type") == "ready"]
            self.assertEqual([event.get("op_id") for event in ready], [31])
        finally:
            new.release_ready.set()
            self.bridge.shutdown_kernel()
            if restart is not None:
                restart.join(3)
            if pump is not None:
                pump.join(3)
            bridge_module.os._exit = original_exit

    def test_iopub_loop_backs_off_instead_of_spinning_on_a_failing_client(self):
        attempts = []
        exits = []

        class FailingClient(ControlledClient):
            def is_alive(self):
                return True

            def get_iopub_msg(self, timeout=1):
                attempts.append(time.monotonic())
                raise RuntimeError("controlled channel failure")

        client = FailingClient()
        self.bridge.kc = client
        self.bridge.km = ControlledManager(client)
        original_exit = bridge_module.os._exit
        bridge_module.os._exit = lambda status: exits.append(status)
        pump = self.start_thread(self.bridge.iopub_loop)
        try:
            deadline = time.monotonic() + 5
            while not exits and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(exits, "a permanently failing IOPub channel must end the bridge")
            self.join(pump)
            self.assertGreater(len(attempts), 0)
            self.assertLess(len(attempts), 30, "the IOPub pump must back off, not busy loop")
            died = [event for event in self.events if event["type"] == "kernel_died"]
            self.assertEqual(len(died), 1)
            self.assertIn("iopub", died[0]["message"])
        finally:
            bridge_module.os._exit = original_exit
            self.bridge.stop.set()

    def test_terminate_signal_runs_the_deterministic_kernel_shutdown(self):
        calls = []
        original_exit = bridge_module.os._exit
        original_shutdown = self.bridge.shutdown_kernel
        self.bridge.shutdown_kernel = lambda: calls.append("shutdown")
        bridge_module.os._exit = lambda status: calls.append(("exit", status))
        try:
            self.bridge.terminate(15, None)
        finally:
            bridge_module.os._exit = original_exit
            self.bridge.shutdown_kernel = original_shutdown
        self.assertEqual(calls, ["shutdown", ("exit", 0)],
                         "a termination signal must clean up the kernel before exiting")

    def test_termination_signals_are_installed_on_the_deterministic_handler(self):
        registered = {}
        original_signal = bridge_module.signal.signal
        bridge_module.signal.signal = lambda number, handler: registered.__setitem__(number, handler)
        try:
            self.bridge.install_signal_handlers()
        finally:
            bridge_module.signal.signal = original_signal
        for name in ("SIGTERM", "SIGINT"):
            number = getattr(bridge_module.signal, name)
            self.assertEqual(registered.get(number), self.bridge.terminate,
                             "%s must route through the deterministic cleanup" % name)


def real_kernel_regression():
    bridge = bridge_module.Bridge()
    events = []
    references = []
    received = 0
    condition = threading.Condition()
    marker = "OLD-PARENT-BACKGROUND:"

    def capture(event):
        with condition:
            events.append(event)
            condition.notify_all()

    original_handle = bridge.handle_iopub

    def track(raw):
        nonlocal received
        if raw.get("content", {}).get("text", "").startswith(marker):
            tracked = TrackedMessage(raw)
            references.append(weakref.ref(tracked))
            original_handle(tracked)
            with condition:
                received += 1
                condition.notify_all()
        else:
            original_handle(raw)

    bridge.handle_iopub = track
    bridge_module.emit = capture

    def wait_reply(exec_id):
        with condition:
            ready = condition.wait_for(lambda: any(
                event.get("type") == "execute_reply" and event.get("exec_id") == exec_id
                for event in events), timeout=15)
        assert ready, "kernel did not finish %s" % exec_id
        reply = next(event for event in events if event.get("type") == "execute_reply"
                     and event.get("exec_id") == exec_id)
        assert reply["ok"], reply
        assert "error" not in reply, reply

    threads = []
    with tempfile.TemporaryDirectory(prefix="dsh-iopub-regression-") as cwd:
        try:
            bridge.start_kernel(cwd)
            for target in [bridge.executor_loop, bridge.iopub_loop]:
                thread = threading.Thread(target=target, daemon=True)
                threads.append(thread)
                thread.start()
            bridge.execute("old-cell", "old-exec", '''import threading, time
kernel = get_ipython().kernel
old_parent = kernel.get_parent()
background_start = threading.Event()
background_done = threading.Event()
def background():
    background_start.wait()
    for index in range(1000):
        kernel.session.send(kernel.iopub_socket, "stream",
            content={"name": "stdout", "text": "OLD-PARENT-BACKGROUND:" + str(index)},
            parent=old_parent)
        time.sleep(0.001)
    background_done.set()
threading.Thread(target=background, daemon=True).start()
''')
            wait_reply("old-exec")
            bridge.execute("current-cell", "current-exec", '''background_start.set()
assert background_done.wait(10)
print("CURRENT RESULT")
''')
            wait_reply("current-exec")
            with condition:
                assert condition.wait_for(lambda: received == 1000, timeout=5), received
            gc.collect()
            result = {
                "received": received,
                "retained": sum(ref() is not None for ref in references),
                "forwarded": sum(event.get("text", "").startswith(marker) for event in events),
                "currentOutput": "".join(event.get("text", "") for event in events
                    if event.get("type") == "stream" and event.get("exec_id") == "current-exec"),
            }
            assert result["retained"] == 0, result
            assert result["forwarded"] == 0, result
            assert result["currentOutput"] == "CURRENT RESULT\n", result
            print(json.dumps(result))
        finally:
            bridge.shutdown_kernel()
            for thread in threads:
                thread.join(3)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge", required=True)
    parser.add_argument("--integration", action="store_true")
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("reviewed_bridge", args.bridge)
    bridge_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge_module)
    if args.integration:
        real_kernel_regression()
    else:
        unittest.main(argv=[__file__], verbosity=2)
