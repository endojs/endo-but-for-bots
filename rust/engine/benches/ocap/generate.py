#!/usr/bin/env python3
"""Generate the fixed object-capability workload sources and manifest."""

import argparse
import hashlib
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent
PARAMETERS = ROOT / "parameters.json"
GENERATED = ROOT / "fixtures"
MANIFEST = ROOT / "manifest.json"
ROSTER = (
    "closure-site",
    "facet-cohort",
    "harden-tree",
    "harden-repeat",
    "ocap-mixed",
    "mutable-control",
)
SIZES = ("small", "representative", "stress")


def program(body):
    return "'use strict';\n(function () {\n" + body.strip() + "\n}())\n"


def closure_site(parameters):
    count = parameters["closure_iterations"]
    checksum = 13 * count * (count - 1) // 2 + 38 * count
    source = program(
        f"""
  function make0() {{ return function (value) {{ return value; }}; }}
  function make1(index) {{ var a = index; return function (value) {{ return value + a; }}; }}
  function make4(index) {{ var a = index; var b = index + 1; var c = index + 2; var d = index + 3; return function (value) {{ return value + a + b + c + d; }}; }}
  function make8(index) {{ var a = index; var b = index + 1; var c = index + 2; var d = index + 3; var e = index + 4; var f = index + 5; var g = index + 6; var h = index + 7; return function (value) {{ return value + a + b + c + d + e + f + g + h; }}; }}
  var closures = [];
  var checksum = 0;
  for (var index = 0; index < {count}; index += 1) {{
    closures.push(make0(), make1(index), make4(index), make8(index));
  }}
  for (var closureIndex = 0; closureIndex < closures.length; closureIndex += 1) {{
    checksum += closures[closureIndex](1);
  }}
  return 'closure-site:{count}:' + checksum + ':' + closures.length;
"""
    )
    return source, f"closure-site:{count}:{checksum}:{count * 4}"


def facet_cohort(parameters):
    cohorts = parameters["facet_cohorts"]
    checksum = 0
    for facet_count in (2, 4, 8):
        for method_count in (2, 4):
            for cohort in range(cohorts):
                state = cohort
                for facet in range(facet_count):
                    state += facet + 1
                    checksum += state
                    if method_count == 4:
                        checksum += state + facet
                        checksum += facet
    source = program(
        f"""
  function makeFacet(shared, facetIndex, methodCount) {{
    if (methodCount === 2) {{
      return {{ step: function (delta) {{ shared.value += delta + facetIndex; return shared.value; }}, read: function () {{ return shared.value; }} }};
    }}
    return {{ step: function (delta) {{ shared.value += delta + facetIndex; return shared.value; }}, read: function () {{ return shared.value; }}, tagged: function () {{ return shared.value + facetIndex; }}, index: function () {{ return facetIndex; }} }};
  }}
  function makeCohort(seed, facetCount, methodCount) {{
    var shared = {{ value: seed }};
    var facets = [];
    for (var facetIndex = 0; facetIndex < facetCount; facetIndex += 1) facets.push(makeFacet(shared, facetIndex, methodCount));
    return facets;
  }}
  var checksum = 0;
  var cohortCount = 0;
  var facetCounts = [2, 4, 8];
  var methodCounts = [2, 4];
  for (var facetShape = 0; facetShape < facetCounts.length; facetShape += 1) {{
    for (var methodShape = 0; methodShape < methodCounts.length; methodShape += 1) {{
      for (var cohortIndex = 0; cohortIndex < {cohorts}; cohortIndex += 1) {{
        var facets = makeCohort(cohortIndex, facetCounts[facetShape], methodCounts[methodShape]);
        cohortCount += 1;
        for (var facetIndex = 0; facetIndex < facets.length; facetIndex += 1) {{
          checksum += facets[facetIndex].step(1);
          if (methodCounts[methodShape] === 4) checksum += facets[facetIndex].tagged() + facets[facetIndex].index();
        }}
      }}
    }}
  }}
  return 'facet-cohort:{cohorts}:' + checksum + ':' + cohortCount;
"""
    )
    return source, f"facet-cohort:{cohorts}:{checksum}:{cohorts * 6}"


def harden_tree(parameters):
    copies = parameters["graph_copies"]
    width = parameters["graph_width"]
    depth = parameters["graph_depth"]
    shared = parameters["graph_shared_leaves"]
    per_copy_objects = 6 + width + depth + shared
    frozen = 2 + copies * per_copy_objects
    per_copy_checksum = width * (width - 1) // 2 + depth * (depth - 1) // 2 + 3 * shared * (shared - 1) // 2
    checksum = copies * per_copy_checksum
    source = program(
        f"""
  function makeGraph(seed) {{
    var wide = {{ kind: 'wide', children: [] }};
    for (var index = 0; index < {width}; index += 1) wide.children.push({{ value: seed + index }});
    var deep = null;
    for (var depthIndex = {depth} - 1; depthIndex >= 0; depthIndex -= 1) deep = {{ value: depthIndex, next: deep }};
    var leaves = [];
    for (var leafIndex = 0; leafIndex < {shared}; leafIndex += 1) leaves.push({{ value: leafIndex * 3 }});
    return {{ wide: wide, deep: deep, dag: {{ left: leaves.slice(), right: leaves.slice() }} }};
  }}
  function census(root) {{
    var seen = [];
    var pending = [root];
    var frozen = 0;
    var checksum = 0;
    while (pending.length > 0) {{
      var value = pending.pop();
      if (value === null || typeof value !== 'object' || seen.indexOf(value) >= 0) continue;
      seen.push(value);
      if (Object.isFrozen(value)) frozen += 1;
      if (typeof value.value === 'number') checksum += value.value;
      var keys = Object.keys(value);
      for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) pending.push(value[keys[keyIndex]]);
    }}
    return [frozen, seen.length, checksum];
  }}
  var graphs = [];
  for (var copy = 0; copy < {copies}; copy += 1) graphs.push(makeGraph(0));
  var root = harden({{ graphs: graphs }});
  var result = census(root);
  return 'harden-tree:{copies}:' + result[0] + ':' + result[1] + ':' + result[2];
"""
    )
    return source, f"harden-tree:{copies}:{frozen}:{frozen}:{checksum}"


def harden_repeat(parameters):
    nodes = parameters["repeat_nodes"]
    repeats = parameters["repeat_count"]
    checks = repeats * 4
    source = program(
        f"""
  var nodes = [];
  for (var index = 0; index < {nodes}; index += 1) nodes.push({{ value: index, prior: index === 0 ? null : nodes[index - 1] }});
  var root = harden({{ nodes: nodes }});
  var checks = 0;
  for (var repeat = 0; repeat < {repeats}; repeat += 1) {{
    checks += harden(root) === root;
    checks += Object.isFrozen(root);
    checks += Object.isSealed(root);
    checks += !Object.isExtensible(root);
  }}
  return 'harden-repeat:{nodes}:{repeats}:' + checks + ':' + (root.nodes[0].value + root.nodes[root.nodes.length - 1].value);
"""
    )
    return source, f"harden-repeat:{nodes}:{repeats}:{checks}:{nodes - 1}"


def mixed_expected(cohorts, mutable):
    checksum = 0
    retained = 0
    for cohort in range(cohorts):
        state = cohort
        for facet in range(4):
            state += facet + 1
            checksum += state
            checksum += state + facet
        state += 2
        checksum += state
        if mutable:
            state += 5
            checksum += state + 11
        if cohort % 2 == 0:
            checksum -= 1
        if cohort % 3 == 0:
            retained += 1
    return checksum, retained


def mixed(parameters, mutable):
    cohorts = parameters["mixed_cohorts"]
    release_batch = parameters["release_batch"]
    checksum, retained = mixed_expected(cohorts, mutable)
    name = "mutable-control" if mutable else "ocap-mixed"
    maybe_harden = "" if mutable else "harden"
    mutate = "cohort.facets[0].step(5); cohort.extra = 11; checksum += cohort.facets[0].read() + cohort.extra;" if mutable else ""
    source = program(
        f"""
  function makePromiseKit() {{
    var resolve;
    var reject;
    var promise = new Promise(function (resolvePromise, rejectPromise) {{ resolve = resolvePromise; reject = rejectPromise; }});
    var kit = {{ promise: promise, resolve: resolve, reject: reject }};
    return {maybe_harden + '(' if maybe_harden else ''}kit{')' if maybe_harden else ''};
  }}
  var facetStates = new WeakMap();
  function facetStep(delta) {{ var state = facetStates.get(this); state.shared.value += delta + state.facetIndex; return state.shared.value; }}
  function facetRead() {{ return facetStates.get(this).shared.value; }}
  function facetTagged() {{ var state = facetStates.get(this); return state.shared.value + state.facetIndex; }}
  function facetIndexMethod() {{ return facetStates.get(this).facetIndex; }}
  function makeFacet(shared, facetIndex) {{
    var facet = {{
      step: facetStep,
      read: facetRead,
      tagged: facetTagged,
      index: facetIndexMethod
    }};
    facetStates.set(facet, {{ shared: shared, facetIndex: facetIndex }});
    return {maybe_harden + '(' if maybe_harden else ''}facet{')' if maybe_harden else ''};
  }}
  function makeForwarder(target) {{
    var active = true;
    var forwarder = {{ call: function (delta) {{ return active ? target.step(delta) : -1; }} }};
    var control = {{ revoke: function () {{ active = false; }} }};
    var pair = {{ forwarder: {maybe_harden + '(' if maybe_harden else ''}forwarder{')' if maybe_harden else ''}, control: {maybe_harden + '(' if maybe_harden else ''}control{')' if maybe_harden else ''} }};
    return {maybe_harden + '(' if maybe_harden else ''}pair{')' if maybe_harden else ''};
  }}
  function makeCohort(seed) {{
    var shared = {{ value: seed }};
    var facets = [];
    for (var facetIndex = 0; facetIndex < 4; facetIndex += 1) facets.push(makeFacet(shared, facetIndex));
    var cohort = {{ facets: facets, promiseKit: makePromiseKit(), forwarding: makeForwarder(facets[0]) }};
    return {maybe_harden + '(' if maybe_harden else ''}cohort{')' if maybe_harden else ''};
  }}
  var retained = [];
  var checksum = 0;
  for (var start = 0; start < {cohorts}; start += {release_batch}) {{
    var batch = [];
    var limit = Math.min(start + {release_batch}, {cohorts});
    for (var cohortIndex = start; cohortIndex < limit; cohortIndex += 1) {{
      var cohort = makeCohort(cohortIndex);
      for (var facetIndex = 0; facetIndex < cohort.facets.length; facetIndex += 1) {{
        checksum += cohort.facets[facetIndex].step(1);
        checksum += cohort.facets[facetIndex].tagged();
      }}
      checksum += cohort.forwarding.forwarder.call(2);
      {mutate}
      if (cohortIndex % 2 === 0) {{ cohort.forwarding.control.revoke(); checksum += cohort.forwarding.forwarder.call(1); }}
      if (cohortIndex % 3 === 0) retained.push(cohort);
      batch.push(cohort);
    }}
    batch = null;
  }}
  return '{name}:{cohorts}:' + checksum + ':' + retained.length;
"""
    )
    return source, f"{name}:{cohorts}:{checksum}:{retained}"


BUILDERS = {
    "closure-site": closure_site,
    "facet-cohort": facet_cohort,
    "harden-tree": harden_tree,
    "harden-repeat": harden_repeat,
    "ocap-mixed": lambda parameters: mixed(parameters, False),
    "mutable-control": lambda parameters: mixed(parameters, True),
}


def rendered_files():
    parameters = json.loads(PARAMETERS.read_text())
    if parameters.get("schema_version") != 1 or tuple(parameters.get("sizes", {})) != SIZES:
        raise ValueError("parameters must contain small, representative, and stress in order")
    files = {}
    fixtures = []
    for name in ROSTER:
        for size in SIZES:
            source, expected = BUILDERS[name](parameters["sizes"][size])
            relative = f"fixtures/{name}-{size}.js"
            files[ROOT / relative] = source
            fixtures.append({"name": name, "size": size, "source": relative, "expected": expected})
    manifest = {"schema_version": 1, "fixtures": fixtures}
    files[MANIFEST] = json.dumps(manifest, indent=2) + "\n"
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if checked-in output differs")
    parser.add_argument("--digest", action="store_true", help="print the fixture-source digest")
    args = parser.parse_args()
    files = rendered_files()
    failures = []
    digest = hashlib.sha256()
    for path, content in sorted(files.items()):
        relative = path.relative_to(ROOT).as_posix().encode()
        payload = content.encode()
        if path.suffix == ".js":
            digest.update(len(relative).to_bytes(8, "big"))
            digest.update(relative)
            digest.update(len(payload).to_bytes(8, "big"))
            digest.update(payload)
        if args.check:
            if not path.exists() or path.read_text() != content:
                failures.append(path.relative_to(ROOT).as_posix())
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
    if args.digest:
        print(digest.hexdigest())
    if failures:
        print("generated fixture drift: " + ", ".join(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
