"""Verify that failed diagnostics cannot leave work running into later timings."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from profile_compile import run_profile


class ProfileProcessTests(unittest.TestCase):
    def test_preserves_command_failure(self):
        self.assertEqual(
            run_profile([sys.executable, "-c", "raise SystemExit(7)"], None, os.environ),
            7,
        )

    def test_timeout_stops_the_benchmark_descendant(self):
        with tempfile.TemporaryDirectory() as temp:
            marker = Path(temp) / "progress"
            pid_file = Path(temp) / "child-pid"
            child = (
                "import os,time,pathlib; "
                f"pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid())); "
                f"p=pathlib.Path({str(marker)!r}); "
                "exec('while True:\\n p.write_text(str(time.monotonic_ns()))\\n time.sleep(.01)')"
            )
            parent = (
                "import subprocess,sys,time; "
                f"subprocess.Popen([sys.executable, '-c', {child!r}]); "
                "time.sleep(30)"
            )
            try:
                with self.assertRaises(subprocess.TimeoutExpired):
                    run_profile(
                        [sys.executable, "-c", parent], temp, os.environ, timeout=1
                    )
                self.assertTrue(pid_file.exists(), "the descendant must have started")
                self.assertTrue(marker.exists(), "the descendant must have done work")
                progress = marker.read_text()
                time.sleep(.1)
                self.assertEqual(marker.read_text(), progress)
            finally:
                # A failing implementation must not leak the test's descendant.
                if pid_file.exists():
                    try:
                        os.kill(int(pid_file.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass


if __name__ == "__main__":
    unittest.main()
