# @endo/thixotrope-harness

The Endo daemon harness (hosted AI-assistant sessions) rebuilt on Thixotrope
(`packages/thixotrope`). Private; nothing here is published.

Vats are the system of record and make the decisions; Node adapters carry the data. Code that
runs in Ironhorse vats lives in `guest/` and reads the Thixotrope prelude (`E`, `Far`, `M`,
`makeExo`, ...) from `globalThis`; it imports only relative modules, so its bundles carry no
second copy of an `@endo/*` library.

- Plan: `designs/architecture.md` (decisions, core changes, limits, test and perf method) and
  `designs/milestones.md` (work units). Surveys are in `designs/survey/`.
- Journal: `JOURNAL.md` records what fits Thixotrope and what does not, and every perf
  measurement.

## Scripts

| Command | What it does |
| --- | --- |
| `node scripts/bundle-guest.mjs [program ...]` | Bundles `guest/<program>/main.js` into `dist-guest/<program>.js`, refusing any module outside `guest/` |
| `node scripts/serve.mjs STATE [--crank-budget N]` | Runs a supervisor with an allowlisted environment and `THIXOTROPE_CRANK_BUDGET`; refuses to lower the budget unless the last shutdown was clean |
| `node scripts/run-lock.mjs [--label L] -- cmd ...` | Runs `cmd` holding `tmp/.run.lock`, so only one Ironhorse workload runs at a time |

## Tests and perf

```sh
corepack yarn test        # unit tests (ses-ava, lockdown)
corepack yarn lint        # tsc + eslint, including the guest rules in lint/guest-rules.js
corepack yarn perf        # every perf/<feature>.perf.mjs, one at a time, under the run lock
```

Integration tests and perf checks need the release worker
(`cargo build --locked --release -p thixotrope-ironhorse-worker` at the repository root) and
fresh bundles (`corepack yarn build:ironhorse-bundles` in `packages/thixotrope`). They run only
under the run lock. Perf scripts use `perf/_harness.mjs`: state goes in `tmp/pf<pid>` and is
removed afterwards (`KEEP_STATE=1` keeps it), each metric is one JSON line (also appended to
`PERF_OUT` when set), and the exit code is 1 when a median is over 1.25 x its budget or
deliveries per operation are over theirs. Paste the lines into `JOURNAL.md` with the commit,
crank budget and load average.
