# PR #1263 review follow-up

Source: [review of 1479b2db](https://github.com/endojs/endo-but-for-bots/pull/1263#issuecomment-5649374708).
The target is one Realm per Machine, with multiple Compartments sharing ordinary
intrinsics and retaining distinct globals and evaluators.

Work in this order; complete an adversarial subagent review and resolve its
findings before every commit.

1. [x] Fix duplicate global endowments and descriptor/integrity enforcement;
   test deletion, frozen globals, and caught native/callback host panics.
2. [x] Separate Machine, Realm, Intrinsics, and compartment environment records;
   preserve canonical keys, code storage, and initialization of primordials once.
3. [x] Add machine-associated rooted value sharing; capture defining environments
   for functions and support direct and nested A → B → A guest calls.
4. [x] Bind indirect eval and Function to their compartment; expose Machine job
   pumping and preserve callback contexts and queue ordering across compartments.
5. [x] Retain environments/code through functions, jobs, and host handles after
   collection and Compartment drop; make queued-work abandonment explicit.
6. [x] Check persistent-worker permit policy at open/resume/rewind, rejection and
   meter isolation, carried-state coverage, and the reported async restore issue.
7. [ ] Reconcile current documentation and PR scope, run appropriate validation,
   push reviewed commits, and continue CI/conflict monitoring.

Multiple Realms, cross-machine messaging, JsMachine (F068/F157), arbitrary host
function registration, and full daemon SES acceptance remain outside this work.
Do not edit the historical architecture review.
