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


if __name__ == "__main__":
    unittest.main()
