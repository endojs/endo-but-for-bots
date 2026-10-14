import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

import common
import cross_target
import differential

LINE = 'halt=Return result="1" meter=5 digest=00 parse_meter=1 charges=1:00 checks=1:00'
OTHER = 'halt=HeapExhausted result="" meter=4 digest=00 parse_meter=1 charges=1:00 checks=1:00'
STACK_TRAP = "trap: 2: wasm trap: call stack exhausted"


def program(label="snippet t.js#a", slow=False):
    return differential.Program(label, [], "1\n", slow)


def entry(label="snippet t.js#a", native=LINE, wasm32=OTHER, site="natives/json.rs:1204"):
    return {"program": label, "site": site, "native": native, "wasm32": wasm32}


class Fakes(unittest.TestCase):
    """A scratch directory for fake probes and lists."""

    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix="cross-target-test-")
        self.addCleanup(scratch.cleanup)
        self.dir = Path(scratch.name)

    def script(self, name, stdout="", stderr="", status=0):
        """An executable that reads its standard input, as a probe does, then
        prints the given streams and exits with `status`."""
        path = self.dir / name
        path.write_text("#!/bin/sh\ncat >/dev/null\n"
                        f"printf '%s' {sh_quote(stdout)}\n"
                        f"printf '%s' {sh_quote(stderr)} >&2\n"
                        f"exit {status}\n")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return path

    def expected(self, *entries, config=None):
        path = self.dir / "expected.json"
        path.write_text(json.dumps({"config": config or {"max_wasm_stack": cross_target.MAX_WASM_STACK},
                                    "expected_divergences": list(entries)}))
        return cross_target.ExpectedDivergences(path, {"max_wasm_stack": cross_target.MAX_WASM_STACK})

    def pair(self, native_stdout, wasm_stdout="", wasm_stderr="", wasm_status=0, work=None):
        native = self.script("native", native_stdout + "\n")
        wasmtime = self.script("wasmtime", wasm_stdout + ("\n" if wasm_stdout else ""), wasm_stderr, wasm_status)
        return cross_target.compare(native, wasmtime, self.dir / "probe.wasm", work or [program()], jobs=2,
                                    timeout=60)


def sh_quote(text):
    return "'" + text.replace("'", "'\"'\"'") + "'"


class Classify(unittest.TestCase):
    def test_verdicts(self):
        self.assertEqual(cross_target.classify(LINE, LINE, None, False), "same")
        self.assertEqual(cross_target.classify(LINE, OTHER, None, False), "differs")
        self.assertEqual(cross_target.classify(LINE, OTHER, entry(), False), "expected")
        self.assertEqual(cross_target.classify(LINE, OTHER + "x", entry(), False), "changed")
        self.assertEqual(cross_target.classify(LINE, LINE, entry(), False), "stale")

    def test_only_a_listed_case_may_trap_on_wasm32(self):
        self.assertEqual(cross_target.classify(LINE, STACK_TRAP, None, True), "expected-trap")
        self.assertEqual(cross_target.classify(LINE, STACK_TRAP, None, False), "differs")
        # A panic is not a trap lane A's list can excuse.
        self.assertEqual(cross_target.classify(LINE, "trap: panic: capacity overflow at bulk.rs", None, True),
                         "differs")

    def test_a_native_trap_or_a_timeout_is_never_expected(self):
        native_trap = "trap: thread '<unnamed>' has overflowed its stack"
        self.assertEqual(cross_target.classify(native_trap, OTHER, entry(native=native_trap), False),
                         "native-trap")
        self.assertEqual(cross_target.classify(LINE, "timeout", entry(wasm32="timeout"), False), "timeout")
        for verdict in ("native-trap", "timeout", "differs", "changed", "stale", "error"):
            self.assertNotIn(verdict, cross_target.PASSING)

    def test_lane_a_names_corpus_cases_only(self):
        self.assertEqual(cross_target.lane_a_case("case parse-functions-512"), "parse-functions-512")
        self.assertIsNone(cross_target.lane_a_case("heavy json-parse 2"))
        self.assertIsNone(cross_target.lane_a_case("snippet a.js#1"))


class FakeProbes(Fakes):
    def test_a_diverging_pair_fails_unless_listed(self):
        pairs = self.pair(LINE, OTHER)
        rows, problems = cross_target.evaluate(pairs, self.expected(), set(), {"snippet t.js#a"})
        self.assertEqual([row["verdict"] for row in rows], ["differs"])
        self.assertEqual((rows[0]["native"], rows[0]["wasm32"]), (LINE, OTHER))
        self.assertEqual(problems, ["differs: snippet t.js#a"])
        rows, problems = cross_target.evaluate(pairs, self.expected(entry()), set(), {"snippet t.js#a"})
        self.assertEqual([row["verdict"] for row in rows], ["expected"])
        self.assertEqual(rows[0]["site"], "natives/json.rs:1204")
        self.assertEqual(problems, [])

    def test_an_agreeing_pair_passes(self):
        rows, problems = cross_target.evaluate(self.pair(LINE, LINE), self.expected(), set(), {"snippet t.js#a"})
        self.assertEqual([row["verdict"] for row in rows], ["same"])
        self.assertEqual(problems, [])

    def test_a_wasm32_panic_is_a_divergence_with_a_portable_report(self):
        stderr = ("thread 'main' (1) panicked at /home/runner/work/x/x/rust/engine/ironhorse-vm/src/interp/"
                  "natives/regexp.rs:301:20:\nattempt to add with overflow\n"
                  "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n")
        (_, native, wasm32, error), = self.pair(LINE, wasm_stderr=stderr, wasm_status=101)
        self.assertIsNone(error)
        self.assertEqual(wasm32, "trap: panic: attempt to add with overflow at "
                                 "ironhorse-vm/src/interp/natives/regexp.rs")
        self.assertEqual(cross_target.classify(native, wasm32, None, True), "differs")

    def test_a_wasm32_allocation_failure_names_its_cause(self):
        stderr = ("memory allocation of 2200000 bytes failed\nError: failed to run main module\n\n"
                  "Caused by:\n    2: wasm trap: wasm `unreachable` instruction executed\n")
        (_, _, wasm32, _), = self.pair(LINE, wasm_stderr=stderr, wasm_status=134)
        self.assertEqual(wasm32, "trap: 2: wasm trap: wasm `unreachable` instruction executed "
                                 "(memory allocation of 2200000 bytes failed)")

    def test_a_listed_case_that_traps_on_wasm32_is_expected(self):
        work = [program("case deep")]
        pairs = self.pair(LINE, wasm_stderr="Caused by:\n    2: wasm trap: call stack exhausted\n", wasm_status=134,
                          work=work)
        rows, problems = cross_target.evaluate(pairs, self.expected(), {"deep"}, {"case deep"})
        self.assertEqual([row["verdict"] for row in rows], ["expected-trap"])
        self.assertEqual(problems, [])

    def test_a_probe_without_a_line_is_an_error(self):
        pairs = self.pair(LINE, wasm_stderr="error: failed to parse -W option\n", wasm_status=1)
        rows, problems = cross_target.evaluate(pairs, self.expected(), set(), {"snippet t.js#a"})
        self.assertEqual([row["verdict"] for row in rows], ["error"])
        self.assertEqual(problems, ["error: snippet t.js#a"])


class ExpectedList(Fakes):
    def test_a_stale_entry_fails(self):
        rows, problems = cross_target.evaluate(self.pair(LINE, LINE), self.expected(entry()), set(),
                                               {"snippet t.js#a"})
        self.assertEqual([row["verdict"] for row in rows], ["stale"])
        self.assertEqual(problems, ["stale: snippet t.js#a"])

    def test_a_changed_divergence_fails(self):
        rows, problems = cross_target.evaluate(self.pair(LINE, OTHER), self.expected(entry(wasm32=STACK_TRAP)),
                                               set(), {"snippet t.js#a"})
        self.assertEqual([row["verdict"] for row in rows], ["changed"])
        self.assertEqual(problems, ["changed: snippet t.js#a"])

    def test_an_entry_for_a_program_that_is_gone_fails(self):
        _, problems = cross_target.evaluate([], self.expected(entry("snippet gone.js#x")), set(), {"snippet t.js#a"})
        self.assertEqual(problems, ["orphan: snippet gone.js#x is listed but no such program exists"])

    def test_an_entry_outside_the_run_is_unchecked(self):
        listed = self.expected(entry("snippet t.js#a"), entry("snippet t.js#b"))
        _, problems = cross_target.evaluate(self.pair(LINE, OTHER), listed, set(),
                                            {"snippet t.js#a", "snippet t.js#b"})
        self.assertEqual(problems, [])

    def test_malformed_lists_are_refused(self):
        for bad in ([{"program": "a", "native": LINE, "wasm32": OTHER}],
                    [entry(), entry()],
                    [entry(site="")],
                    [entry(wasm32=LINE)],
                    [dict(entry(), extra="x")]):
            with self.subTest(bad=bad):
                with self.assertRaises(cross_target.ListError):
                    self.expected(*bad)

    def test_update_shrinks_and_rerecords_but_never_grows(self):
        listed = self.expected(entry("snippet t.js#stale"), entry("snippet t.js#changed"),
                               entry("snippet t.js#kept"), entry("snippet gone.js#x"))
        rows = [{"program": "snippet t.js#stale", "verdict": "stale", "native": LINE, "wasm32": LINE},
                {"program": "snippet t.js#changed", "verdict": "changed", "native": LINE, "wasm32": STACK_TRAP},
                {"program": "snippet t.js#new", "verdict": "differs", "native": LINE, "wasm32": OTHER}]
        known = {"snippet t.js#stale", "snippet t.js#changed", "snippet t.js#kept", "snippet t.js#new"}
        answered = cross_target.update(listed, rows, known)
        self.assertEqual(answered, {"snippet t.js#stale", "snippet t.js#changed"})
        written = json.loads(listed.path.read_text())["expected_divergences"]
        self.assertEqual([e["program"] for e in written], ["snippet t.js#changed", "snippet t.js#kept"])
        self.assertEqual(written[0]["wasm32"], STACK_TRAP)
        self.assertEqual(written[0]["site"], "natives/json.rs:1204")

    def test_the_checked_in_list_is_well_formed_and_names_its_sites(self):
        config = {"max_wasm_stack": cross_target.MAX_WASM_STACK}
        listed = cross_target.ExpectedDivergences(cross_target.EXPECTED, config)
        self.assertTrue(listed.config_matches())
        self.assertTrue(listed.entries)
        snippets = {p.label for p in differential.snippet_inputs()}
        for label in listed.entries:
            self.assertIn(label, snippets, "every entry names a B7 snippet")


class Main(Fakes):
    """The script end to end, with fake probes and a one-program run."""

    def run_main(self, native_line, wasm_line, *entries):
        native = self.script("native", native_line + "\n")
        wasmtime = self.script("wasmtime", wasm_line + "\n")
        wasm = self.script("probe.wasm")
        self.expected(*entries)
        artifacts = {None: native, "wasm32-wasip1": wasm}
        with mock.patch.object(cross_target.build_probe, "artifact", lambda target=None: artifacts[target]), \
                mock.patch.object(cross_target.differential, "labels", lambda probe: {"snippet t.js#a"}), \
                mock.patch.object(cross_target.differential, "inputs", lambda *args: [program()]), \
                mock.patch("sys.stdout", new_callable=lambda: open(os.devnull, "w")) as out:
            try:
                return cross_target.main(["--no-build", "--wasmtime", str(wasmtime),
                                          "--expected", str(self.dir / "expected.json")])
            finally:
                out.close()

    def test_a_stale_entry_fails_the_run(self):
        self.assertEqual(self.run_main(LINE, LINE, entry()), 1)

    def test_an_unlisted_divergence_fails_the_run(self):
        self.assertEqual(self.run_main(LINE, OTHER), 1)

    def test_a_listed_divergence_passes(self):
        self.assertEqual(self.run_main(LINE, OTHER, entry()), 0)


if __name__ == "__main__":
    unittest.main()
