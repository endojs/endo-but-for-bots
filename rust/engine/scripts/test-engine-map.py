"""Fixture checks for the architecture model extractor and the map renderer.

The map's whole claim is that it reports real structures, so the tests here
pin the extraction rules that claim rests on: dependency layering that ignores
development edges, brace scanning that survives struct-shaped variants, source
constants winning over the guide's prose, and sentence recovery across wrapped
Markdown lines.
"""

import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


model = load("engine_map_model", "engine-map-model.py")
page = load("engine_map", "engine-map.py")


def crates():
    return [
        {"name": "meter", "deps": [], "lines": 10},
        {"name": "vm", "lines": 90, "deps": [
            {"name": "meter", "kind": "normal", "optional": False},
            {"name": "compile", "kind": "dev", "optional": False},
        ]},
        {"name": "compile", "lines": 20, "deps": [
            {"name": "meter", "kind": "normal", "optional": False}]},
        {"name": "runtime", "lines": 5, "deps": [
            {"name": "vm", "kind": "normal", "optional": False},
            {"name": "compile", "kind": "normal", "optional": False}]},
    ]


class LayeringTests(unittest.TestCase):
    def test_foundations_sit_at_depth_zero(self):
        self.assertEqual(page.layered(crates())["meter"], 0)

    def test_development_edges_do_not_raise_depth(self):
        # The VM's only production edge is the meter, so a dev edge on the
        # compiler must not stack it above the compiler.
        depth = page.layered(crates())
        self.assertEqual(depth["vm"], 1)
        self.assertEqual(depth["compile"], 1)

    def test_dependent_sits_above_everything_it_links(self):
        depth = page.layered(crates())
        self.assertGreater(depth["runtime"], max(depth["vm"], depth["compile"]))

    def test_dependency_cycle_terminates(self):
        cyclic = [
            {"name": "a", "lines": 1, "deps": [{"name": "b", "kind": "normal", "optional": False}]},
            {"name": "b", "lines": 1, "deps": [{"name": "a", "kind": "normal", "optional": False}]},
        ]
        self.assertEqual(set(page.layered(cyclic)), {"a", "b"})


class SentenceTests(unittest.TestCase):
    def test_sentence_wrapped_over_lines_is_rejoined(self):
        # This repository wraps at 80 columns, so reading line by line beheads
        # every sentence that runs over; the subject lives on the first line.
        lines = [("Remaining bypasses are tracked;", 12),
                 ("a central dispatcher is not evidence that every call site", 13),
                 ("already uses it.", 14)]
        recovered = model.paragraph_sentences(lines)
        self.assertIn("a central dispatcher is not evidence that every call site "
                      "already uses it.", [s for s, _ in recovered])

    def test_sentence_reports_the_line_it_starts_on(self):
        lines = [("First sentence here.", 40), ("Second starts later.", 41)]
        self.assertEqual([n for _, n in model.paragraph_sentences(lines)], [40, 41])

    def test_empty_paragraph_is_safe(self):
        self.assertEqual(model.paragraph_sentences([]), [])


class MarkupTests(unittest.TestCase):
    def test_markdown_links_collapse_to_their_text(self):
        self.assertEqual(model.plain("see [`gc.rs`](vm/tests/gc.rs) now"), "see `gc.rs` now")

    def test_bold_markers_are_removed_and_backticks_kept(self):
        self.assertEqual(model.plain("**never** call `foo`"), "never call `foo`")

    def test_long_doc_is_truncated_on_a_word_boundary(self):
        sentence = model.first_sentence("word " * 80, limit=40)
        self.assertTrue(sentence.endswith("…"))
        self.assertLessEqual(len(sentence), 42)


class EnumTests(unittest.TestCase):
    def test_struct_shaped_variant_does_not_end_the_scan(self):
        # `Throw { .. }` opens and closes a brace on one line. A scan starting
        # at depth zero stops there and loses every later variant.
        source = (
            "pub enum Halt {\n"
            "    /// One.\n    Return,\n"
            "    /// Two.\n    Throw { value: Slot, rendered: String },\n"
            "    /// Three.\n    Panic(PanicKind),\n"
            "}\n"
        )
        path = Path(self.tmp) / "x.rs"
        path.write_text(source)
        names = [v["name"] for v in model.enum_variants(path.name, "Halt")]
        self.assertEqual(names, ["Return", "Throw", "Panic"])

    def test_struct_variant_fields_are_not_variants(self):
        source = (
            "pub enum Halt {\n"
            "    ReentryLimit {\n        Depth: usize,\n    },\n"
            "    Decode(DecodeError),\n"
            "}\n"
        )
        path = Path(self.tmp) / "y.rs"
        path.write_text(source)
        names = [v["name"] for v in model.enum_variants(path.name, "Halt")]
        self.assertEqual(names, ["ReentryLimit", "Decode"])

    def setUp(self):
        import tempfile
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.tmp = self.dir.name
        self._engine = model.ENGINE
        model.ENGINE = Path(self.tmp)

    def tearDown(self):
        model.ENGINE = self._engine


class ImplTests(unittest.TestCase):
    def test_path_qualified_and_indented_impls_are_found(self):
        text = "        impl crate::gc::GcHooks for Hooks<'_> {\n"
        match = model.IMPL_RE.search(text)
        self.assertIsNotNone(match)
        self.assertEqual(match.group("trait"), "GcHooks")
        self.assertEqual(match.group("type"), "Hooks")

    def test_cfg_test_block_is_recognised(self):
        text = "fn real() {}\n#[cfg(test)]\nmod tests {\n    impl X for Y {}\n"
        self.assertTrue(model.under_cfg_test(text, text.index("impl X")))

    def test_impl_after_a_closed_test_module_is_production(self):
        text = "#[cfg(test)]\nmod tests {\n}\nimpl X for Y {}\n"
        self.assertFalse(model.under_cfg_test(text, text.index("impl X")))


class DriftTests(unittest.TestCase):
    def test_guide_value_behind_source_is_reported_as_drift(self):
        claims = model.doc_claims(
            "| Identifier | Owner and current value | Bump rule |\n"
            "|---|---|---|\n"
            "| `STORE_SCHEMA_VERSION` | Snapshot `store.rs`: 33 | bump it |\n")
        self.assertEqual(claims["STORE_SCHEMA_VERSION"], "33")

    def test_release_literals_are_read_as_strings(self):
        claims = model.doc_claims(
            "| `COST_TABLE_VERSION` | meter `lib.rs`: `ironhorse-meter-5` | append |\n")
        self.assertEqual(claims["COST_TABLE_VERSION"], "ironhorse-meter-5")


class RenderTests(unittest.TestCase):
    def fixture(self):
        return {
            "commit": "abc123def456",
            "totals": {"crates": 1, "lines": 10, "modules": 1, "tests": 2},
            "crates": [{
                "name": "ironhorse-vm", "description": "d", "dir": "rust/engine/vm",
                "lib_root": "rust/engine/vm/src/lib.rs", "doc": "doc", "lines": 10,
                "forbids_unsafe": True, "module_count": 1, "deps": [],
                "modules": [{"path": "rust/engine/vm/src/lib.rs", "module": "lib",
                             "lines": 10, "doc": "root"}],
                "surface": {}, "tests": {"count": 2, "groups": {"gc": 2}},
            }],
            "seams": [{"name": "GcHooks", "why": "w", "owner": "vm", "kind": "trait",
                       "file": "rust/engine/vm/src/gc.rs", "line": 5,
                       "implementors": [], "production_implementors": []}],
            "constants": [{"name": "ROW_SCHEMA_VERSION", "value": "4", "type": "u32",
                           "file": "rust/engine/vm/src/a.rs", "line": 1,
                           "documented": "3", "drift": True}],
            "hazards": [{"text": "A side-table edge is not automatically a root.",
                         "context": "", "source": "ARCHITECTURE.md", "line": 250,
                         "section": "Seam 3", "score": 5}],
            "consumers": [{"path": "rust/endo/src/e.rs", "role": "r", "lines": 5}],
            "recipes": [{"goal": "g", "note": "n", "waypoints": [
                {"path": "rust/engine/vm/src/gc.rs", "why": "w", "exists": True, "kind": "file"}]}],
            "checks": [{"workflow": "ci.yml", "step": "s", "commands": ["cargo test"]}],
            "halts": [{"name": "Throw", "doc": "d", "kind": "guest"},
                      {"name": "MeterAbort", "doc": "d", "kind": "host"}],
            "acceptance": [{"stage": "1", "bar": "b", "verdict": "Landed",
                            "evidence": "e", "state": "landed"}],
        }

    def test_links_pin_to_the_recorded_commit(self):
        out = page.render(self.fixture())
        self.assertIn("/blob/abc123def456/rust/engine/vm/src/gc.rs#L5", out)

    def test_drifted_constant_is_surfaced_not_hidden(self):
        out = page.render(self.fixture())
        self.assertIn("guide says 3", out)
        self.assertIn("does not agree with the source", out)

    def test_no_drift_suppresses_the_warning(self):
        data = self.fixture()
        data["constants"][0]["drift"] = False
        self.assertNotIn("does not agree with the source", page.render(data))

    def test_halt_kinds_reach_the_filter_markup(self):
        out = page.render(self.fixture())
        self.assertIn('data-kind="guest"', out)
        self.assertIn('data-kind="host"', out)

    def test_model_text_is_escaped(self):
        data = self.fixture()
        data["hazards"][0]["text"] = 'a <script>alert("x")</script> & more'
        out = page.render(data)
        self.assertNotIn("<script>alert", out)
        self.assertIn("&lt;script&gt;", out)

    def test_render_is_deterministic(self):
        self.assertEqual(page.render(self.fixture()), page.render(self.fixture()))


class CheckedInTests(unittest.TestCase):
    """The committed model and page must agree with the committed sources."""

    def test_model_and_page_are_present_and_consistent(self):
        self.assertTrue(model.OUTPUT.is_file(), "run engine-map-model.py")
        self.assertTrue(page.OUTPUT.is_file(), "run engine-map.py")
        import json
        self.assertEqual(page.OUTPUT.read_text(),
                         page.render(json.loads(model.OUTPUT.read_text())),
                         "architecture-map.html is stale; rerun engine-map.py")

    def test_every_recipe_waypoint_exists(self):
        import json
        data = json.loads(model.OUTPUT.read_text())
        missing = [w["path"] for r in data["recipes"] for w in r["waypoints"]
                   if not w["exists"]]
        self.assertEqual(missing, [], "recipe waypoints point at missing files")

    def test_every_seam_was_located(self):
        import json
        data = json.loads(model.OUTPUT.read_text())
        self.assertEqual({s["name"] for s in data["seams"]},
                         {name for name, _, _ in model.SEAMS})


if __name__ == "__main__":
    unittest.main()
