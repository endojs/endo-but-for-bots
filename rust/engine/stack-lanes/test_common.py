from pathlib import Path
import shutil
import subprocess
import unittest

import common


def completed(stdout="", stderr="", returncode=0):
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


class OutcomeParsing(unittest.TestCase):
    def test_an_engine_panic_is_a_harness_error_not_a_trap(self):
        stderr = "thread '<unnamed>' panicked at src/x.rs:1:1:\nindex out of bounds: the len is 1 but the index is 2\n"
        with self.assertRaises(common.HarnessError):
            common._outcome(completed("", stderr, returncode=101), common.NATIVE_TRAP, signal_is_trap=True)

    def test_a_node_host_error_is_a_harness_error(self):
        with self.assertRaises(common.HarnessError):
            common._outcome(completed("", "HOST ERROR: ENOENT\n", returncode=4), common.NODE_TRAP, False)

    def test_a_timeout_is_not_a_trap(self):
        o = common.Outcome(trap="timeout after 9s", timed_out=True)
        self.assertFalse(o.trapped)
        self.assertTrue(o.timed_out)

    def test_probe_line_is_the_outcome(self):
        o = common._outcome(completed('halt=Return result="1" meter=5\n'), common.NATIVE_TRAP, True)
        self.assertEqual(o.line, 'halt=Return result="1" meter=5')
        self.assertFalse(o.trapped)

    def test_compile_line_is_the_outcome(self):
        o = common._outcome(completed("compile=ok\n"), common.NATIVE_TRAP, True)
        self.assertEqual(o.line, "compile=ok")
        self.assertFalse(o.trapped)

    def test_trap_marker_on_stderr_is_a_trap(self):
        o = common._outcome(completed("", "TRAP: Maximum call stack size exceeded\n"), common.NODE_TRAP, False)
        self.assertTrue(o.trapped)
        self.assertIn("Maximum call stack", o.trap)

    def test_wasmtime_trap_is_a_trap(self):
        o = common._outcome(completed("", "Error: failed to run main module\n\nCaused by:\n    2: wasm trap: call stack exhausted\n", returncode=134),
                            common.WASMTIME_TRAP, signal_is_trap=False)
        self.assertTrue(o.trapped)
        self.assertIn("call stack exhausted", o.trap)

    def test_a_signal_is_a_native_trap(self):
        o = common._outcome(completed("", "", returncode=-6), common.NATIVE_TRAP, signal_is_trap=True)
        self.assertTrue(o.trapped)
        self.assertEqual(o.trap, "signal 6")

    def test_no_output_without_a_trap_is_a_harness_error(self):
        with self.assertRaises(common.HarnessError):
            common._outcome(completed("", "error: failed to parse -W option\n", returncode=1),
                            common.WASMTIME_TRAP, signal_is_trap=False)

    def test_result_text_containing_a_marker_is_not_a_trap(self):
        # Markers are looked for on stderr only; a program's result never trips them.
        o = common._outcome(completed('halt=Return result="error: TRAP: wasm trap:" meter=1\n'), common.NODE_TRAP, False)
        self.assertFalse(o.trapped)
        self.assertEqual(o.line, 'halt=Return result="error: TRAP: wasm trap:" meter=1')

    def test_last_probe_line_wins(self):
        o = common._outcome(completed("noise\ncompile=ok\nhalt=Return result=\"2\" meter=9\n"), common.NATIVE_TRAP, True)
        self.assertEqual(o.line, 'halt=Return result="2" meter=9')


class ExpectedTrapsList(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.dir = tempfile.TemporaryDirectory()
        self.path = f"{self.dir.name}/expected.json"

    def tearDown(self):
        self.dir.cleanup()

    def test_partial_run_keeps_untested_listings(self):
        common.write_json(self.path, {"config": {"stack": 1}, "expected_traps": ["a", "b"]})
        expected = common.ExpectedTraps(self.path, {"stack": 1})
        self.assertTrue(expected.config_matches())
        problems, wrote = expected.update(selected_names=["a"], trapped=set(), problems=[
            "a: listed as an expected trap but passed; remove it from the list (--update-expected)"],
            allow_grow=False)
        self.assertEqual(problems, [])
        self.assertTrue(wrote)
        self.assertEqual(common.ExpectedTraps(self.path, {"stack": 1}).names, {"b"})

    def test_growth_needs_allow_grow(self):
        common.write_json(self.path, {"config": {"stack": 1}, "expected_traps": []})
        expected = common.ExpectedTraps(self.path, {"stack": 1})
        problems, wrote = expected.update(["a"], {"a"}, ["a: unexpected trap: x"], allow_grow=False)
        self.assertEqual(len(problems), 2)
        self.assertFalse(wrote)
        self.assertEqual(common.ExpectedTraps(self.path, {"stack": 1}).names, set())
        problems, wrote = expected.update(["a"], {"a"}, ["a: unexpected trap: x"], allow_grow=True)
        self.assertEqual(problems, [])
        self.assertTrue(wrote)
        self.assertEqual(common.ExpectedTraps(self.path, {"stack": 1}).names, {"a"})

    def test_an_undecided_case_keeps_its_listing(self):
        common.write_json(self.path, {"config": {"stack": 1}, "expected_traps": ["a"]})
        expected = common.ExpectedTraps(self.path, {"stack": 1})
        problems, _ = expected.update(["a"], set(), ["a: timeout: native x, host y"], False, undecided={"a"})
        self.assertEqual(len(problems), 1)
        self.assertEqual(common.ExpectedTraps(self.path, {"stack": 1}).names, {"a"})

    def test_config_mismatch_is_visible(self):
        common.write_json(self.path, {"config": {"stack": 1}, "expected_traps": []})
        self.assertFalse(common.ExpectedTraps(self.path, {"stack": 2}).config_matches())


class LaneB(unittest.TestCase):
    """common.run_lane_b and lane_b_expected, which both lane B hosts run."""

    def setUp(self):
        import argparse
        import contextlib
        import io
        import tempfile
        self.dir = tempfile.TemporaryDirectory()
        self.path = f"{self.dir.name}/expected.json"
        self.args = argparse.Namespace(update_expected=False, allow_grow=False, shadow_stack=1 << 20,
                                       case=None, shard="all")
        self.cfg = {"v8_flags": ["--x"], "shadow_stack": 1 << 20}
        self.cases = [{"name": "a"}, {"name": "b"}, {"name": "c"}]
        self.reference = {name: common.Outcome(line=f"halt=none result={name}") for name in "abc"}
        self.quiet = contextlib.redirect_stdout(io.StringIO())

    def tearDown(self):
        self.dir.cleanup()

    def run_lane(self, hosts, listed=()):
        common.write_json(self.path, {"config": self.cfg, "expected_traps": sorted(listed)})
        expected = common.lane_b_expected(self.path, self.cfg, self.args)
        with self.quiet:
            return common.run_lane_b("lane B", "cfg", "cfg", expected, self.cases, self.reference,
                                     lambda name: hosts[name], self.args)

    def test_verdicts_against_the_reference_and_the_list(self):
        trap = common.Outcome(trap="TRAP: RangeError")
        report, problems = self.run_lane({"a": self.reference["a"], "b": trap, "c": trap}, listed={"b"})
        self.assertEqual({n: r["verdict"] for n, r in report["cases"].items()},
                         {"a": "pass", "b": "expected-trap", "c": "unexpected trap: TRAP: RangeError"})
        self.assertEqual(problems, ["c: unexpected trap: TRAP: RangeError"])
        self.assertEqual(report["config"], self.cfg)

    def test_a_mark_inside_the_margin_is_a_problem(self):
        hosts = {name: common.Outcome(line=self.reference[name].line) for name in "abc"}
        hosts["a"].shadow_stack = self.args.shadow_stack - common.LANE_B_SHADOW_MARGIN + 1
        hosts["b"].shadow_stack = 4096
        report, problems = self.run_lane(hosts)
        self.assertEqual(report["shadow_stack"], {"a": hosts["a"].shadow_stack, "b": 4096})
        self.assertEqual(len(problems), 1)
        self.assertIn("a: shadow stack", problems[0])

    def test_a_probe_linked_with_another_shadow_stack_stops_the_lane(self):
        hosts = {name: common.Outcome(line=self.reference[name].line) for name in "abc"}
        hosts["a"].shadow_stack_top = 4096
        with self.assertRaisesRegex(SystemExit, "pass --shadow-stack 4096"):
            self.run_lane(hosts)

    def test_a_host_that_cannot_run_a_case_stops_the_lane(self):
        def failing(name):
            raise common.HarnessError("no such file")
        common.write_json(self.path, {"config": self.cfg, "expected_traps": []})
        expected = common.lane_b_expected(self.path, self.cfg, self.args)
        with self.quiet, self.assertRaisesRegex(SystemExit, r"lane B \(cfg\) cannot run a: no such file"):
            common.run_lane_b("lane B", "cfg", "cfg", expected, self.cases, self.reference, failing,
                              self.args)

    def test_a_list_recorded_under_another_configuration_is_refused(self):
        common.write_json(self.path, {"config": {"v8_flags": []}, "expected_traps": []})
        with self.assertRaisesRegex(SystemExit, "--update-expected"):
            common.lane_b_expected(self.path, self.cfg, self.args)
        self.args.update_expected = True
        self.args.shard = "fast"
        with self.assertRaisesRegex(SystemExit, "whole corpus"):
            common.lane_b_expected(self.path, self.cfg, self.args)
        self.args.shard = "all"
        self.assertFalse(common.lane_b_expected(self.path, self.cfg, self.args).config_matches())


def painted_module(stack_top, dirty_address):
    """A wasm module exporting `memory`, a mutable `__stack_pointer` at
    `stack_top` and a `_start` that writes one byte at `dirty_address`."""
    def leb(value):
        out = bytearray()
        while True:
            byte = value & 0x7F
            value >>= 7
            if value:
                out.append(byte | 0x80)
            else:
                out.append(byte)
                return bytes(out)

    def section(kind, body):
        return bytes([kind]) + leb(len(body)) + body

    def name(text):
        return leb(len(text)) + text.encode()

    exports = (b"\x03" + name("memory") + b"\x02\x00" + name("__stack_pointer") + b"\x03\x00"
               + name("_start") + b"\x00\x00")
    code = b"\x00\x41" + leb(dirty_address) + b"\x41\x01\x3a\x00\x00\x0b"
    return (b"\x00asm\x01\x00\x00\x00"
            + section(1, b"\x01\x60\x00\x00")
            + section(3, b"\x01\x00")
            + section(5, b"\x01\x00\x01")
            + section(6, b"\x01\x7f\x01\x41" + leb(stack_top) + b"\x0b")
            + section(7, exports)
            + section(10, b"\x01" + leb(len(code)) + code))


@unittest.skipUnless(shutil.which("node"), "needs node")
class ShadowPaint(unittest.TestCase):
    """node/run.cjs paints with the painter it shares with workerd's Worker."""

    def test_the_node_runner_reports_the_high_water_mark(self):
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            wasm = Path(directory) / "painted.wasm"
            wasm.write_bytes(painted_module(stack_top=4096, dirty_address=3000))
            completed = subprocess.run(["node", str(common.NODE_RUNNER), str(wasm)], text=True,
                                       capture_output=True, env=dict(os.environ, PAINT_SHADOW_STACK="1"))
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("SHADOW_STACK_TOP: 4096\n", completed.stderr)
        self.assertIn("SHADOW_STACK: 1096\n", completed.stderr)

    def test_the_workerd_worker_embeds_the_same_painter(self):
        config = (common.LANES / "workerd/config.capnp.in").read_text()
        self.assertIn('esModule = embed "shadow-paint.mjs"', config)
        worker = (common.LANES / "workerd/worker.js").read_text()
        self.assertIn('from "shadow-paint.mjs"', worker)
        self.assertNotIn("SENTINEL", worker)


class StackLimit(unittest.TestCase):
    """A V8 --stack-size past the process's stack needs the limit raised."""
    INFINITY = common.resource.RLIM_INFINITY

    def test_a_limit_that_holds_the_stack_is_left_alone(self):
        self.assertIsNone(common.stack_limit_raiser(4096, (self.INFINITY, self.INFINITY)))
        self.assertIsNone(common.stack_limit_raiser(4096, ((4096 + common.NODE_STACK_SLACK_KB) * 1024,
                                                           self.INFINITY)))

    def test_a_smaller_soft_limit_is_raised(self):
        self.assertTrue(callable(common.stack_limit_raiser(16384, (8 << 20, self.INFINITY))))
        self.assertTrue(callable(common.stack_limit_raiser(16384, (8 << 20, 64 << 20))))

    def test_a_hard_limit_too_small_is_a_harness_error(self):
        with self.assertRaisesRegex(common.HarnessError, "cannot hold a 16384 KiB"):
            common.stack_limit_raiser(16384, (8 << 20, 8 << 20))

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_node_runs_under_a_raised_limit(self):
        """A recursion that needs more than an 8 MiB process stack completes
        under a 32 MiB V8 stack with the limit raised; without the raise it
        would fault, not throw."""
        script = ("function f(n) { return n === 0 ? 0 : 1 + f(n - 1); }"
                  "console.log(f(300000));")
        raiser = common.stack_limit_raiser(32768, (8 << 20, self.INFINITY))
        completed = subprocess.run(["node", "--stack-size=32768", "-e", script], text=True,
                                   capture_output=True, preexec_fn=raiser)
        self.assertEqual((completed.returncode, completed.stdout), (0, "300000\n"), completed.stderr)


class SelectCases(unittest.TestCase):
    cases = [{"name": "a"}, {"name": "slow"}, {"name": "b"}]

    def test_shards_and_names(self):
        pick = lambda names, shard: [c["name"] for c in common.select_cases(self.cases, names, shard, ("slow",))]
        self.assertEqual(pick(None, "fast"), ["a", "b"])
        self.assertEqual(pick(None, "slow"), ["slow"])
        self.assertEqual(pick(None, "all"), ["a", "slow", "b"])
        self.assertEqual(pick(["b"], "fast"), ["b"])
        self.assertEqual(pick(["slow"], "fast"), [])


class TrapFrames(unittest.TestCase):
    STDERR = (
        "SHADOW_STACK_TOP: 4195328\n"
        "TRAP FRAME: probe.wasm._ZN1a1f17h0000000000000001E (wasm://wasm/probe.wasm-01ae661e:wasm-function[757]:0xa3c68)\n"
        "TRAP FRAME: probe.wasm._ZN1a1g17h0000000000000002E (wasm://wasm/probe.wasm-01ae661e:wasm-function[12]:0x100)\n"
        "TRAP FRAME: WASI.start (node:wasi:136:7)\n"
        "TRAP FRAME: main (/x/run.cjs:45:23)\n"
        "TRAP: Maximum call stack size exceeded\n")

    def test_wasm_frames_are_read_from_the_trap_stack_innermost_first(self):
        self.assertEqual(common.trap_frames_from(self.STDERR), [757, 12])

    def test_the_frame_lines_do_not_read_as_the_trap_marker(self):
        o = common._outcome(completed("", self.STDERR, returncode=3), common.NODE_TRAP, False)
        self.assertTrue(o.trapped)
        self.assertEqual(o.trap, "TRAP: Maximum call stack size exceeded")


if __name__ == "__main__":
    unittest.main()
