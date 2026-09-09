# Engine crate dependencies

Generated from Cargo metadata; do not edit this diagram by hand.
Regenerate: `python3 rust/engine/scripts/crate-graph.py` from the repository root.
CI checks drift with the same command plus `--check`.
Arrows point from dependent to dependency.
Solid edges are normal dependencies; dashed edges are development dependencies.
Optional dependencies are labeled: their presence does not mean the default build links them.

```mermaid
flowchart TD
    ironhorse_262["ironhorse-262"]
    ironhorse_compile["ironhorse-compile"]
    ironhorse_fuzz["ironhorse-fuzz"]
    ironhorse_meter["ironhorse-meter"]
    ironhorse_regexp["ironhorse-regexp"]
    ironhorse_snapshot["ironhorse-snapshot"]
    ironhorse_text["ironhorse-text"]
    ironhorse_vm["ironhorse-vm"]
    xs_oracle["xs-oracle"]
    ironhorse_262 -->|"normal"| ironhorse_compile
    ironhorse_262 -->|"normal"| ironhorse_vm
    ironhorse_262 -->|"normal"| xs_oracle
    ironhorse_compile -->|"normal"| ironhorse_meter
    ironhorse_compile -->|"normal"| ironhorse_regexp
    ironhorse_compile -->|"normal"| ironhorse_text
    ironhorse_compile -->|"normal optional"| xs_oracle
    ironhorse_fuzz -->|"normal"| ironhorse_compile
    ironhorse_fuzz -->|"normal"| ironhorse_regexp
    ironhorse_fuzz -->|"normal"| ironhorse_snapshot
    ironhorse_fuzz -->|"normal"| ironhorse_vm
    ironhorse_fuzz -->|"normal"| xs_oracle
    ironhorse_regexp -->|"normal"| ironhorse_meter
    ironhorse_regexp -->|"normal optional"| xs_oracle
    ironhorse_snapshot -->|"normal optional"| ironhorse_compile
    ironhorse_snapshot -.->|"dev"| ironhorse_compile
    ironhorse_snapshot -.->|"dev"| ironhorse_snapshot
    ironhorse_snapshot -->|"normal"| ironhorse_vm
    ironhorse_snapshot -.->|"dev"| ironhorse_vm
    ironhorse_vm -.->|"dev"| ironhorse_compile
    ironhorse_vm -->|"normal"| ironhorse_meter
    ironhorse_vm -->|"normal"| ironhorse_regexp
    ironhorse_vm -->|"normal"| ironhorse_text
    xs_oracle -.->|"dev"| ironhorse_vm
```

This graph includes optional oracle dependencies and the self development edge used
to enable snapshot tooling in tests.
External dependencies and outer-workspace consumers are described in
[ARCHITECTURE.md](ARCHITECTURE.md), not represented as workspace members.
