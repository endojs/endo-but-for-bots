// self-improver.mjs — the safe overnight "fork → implement → verify → auto-merge-if-improved → rollback" loop.
//
// This is the organ that lets a recurring system-improvement agent ACTUALLY change the system
// instead of only posting a recommendation. The safety is structural, not trust-based:
//
//   1. FORK   — the change is implemented on an ISOLATED git worktree branch (never the live tree).
//   2. VERIFY — the loop INDEPENDENTLY runs the spec suite on that branch (the implementer's own
//               "it works" claim does NOT count — we re-run the tests ourselves).
//   3. MERGE  — only if the suite is GREEN and the live checkout is CLEAN and the merge is conflict-free.
//               Merge is `--no-ff`, so every auto-merge is ONE revertible merge commit.
//   4. LEDGER — every merge is recorded {branch, mergeCommit, baseBefore} so rollback is one command.
//
// "Shown to be an improvement" = the full suite passes (no regression) AND the change shipped with a
// passing test that encodes its claim — that's the implementer's contract (see the prompt that drives it).
// merge() refuses on a dirty live tree or a conflict; it can NEVER clobber uncommitted work or half-merge.
//
// The implementer is INJECTED (`employExecutor`) so the whole loop is testable with a deterministic fake;
// in production it is the worktree-isolated `executor` role.
import fs from 'node:fs';
import path from 'node:path';

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`; // POSIX single-quote for shell interpolation
const slug = s => String(s).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'x';
const tail = (r, n = 1600) => String((r && (r.stderr || r.stdout)) || '').slice(-n);

// makeSelfImprover({ host, repo, baseBranch, verifyDir, ledgerFile, defaultTest, timeoutMs })
//   host        — the UNCONFINED host shell (this loop IS trusted harness; the IMPLEMENTER is the confined part).
//   repo        — the git repo whose live working tree the merge lands in (e.g. /home/dan/endo-bfb-llm).
//   baseBranch  — the live branch auto-merges target (e.g. 'field-preact'); also the fork base.
//   verifyDir   — scratch dir for the independent verification checkout.
//   ledgerFile  — JSON file of every auto-merge (the rollback record + the morning digest source).
//   defaultTest — the verification command run IN the branch's worktree (a task may override per-run).
export const makeSelfImprover = ({ host, repo, baseBranch = 'HEAD', verifyDir, ledgerFile, defaultTest = 'echo no-test-configured && false', timeoutMs = 600000 } = {}) => {
  const vbase = verifyDir || path.join(repo, '..', '.self-improve-verify');
  // The ledger is the ONLY record that makes an auto-merge revertible from the UI, so its read/write is
  // authoritative — NOT best-effort. Missing file → fresh ledger; a present-but-CORRUPT file THROWS rather
  // than silently returning empty (which would hide every prior merge and let the next write overwrite it).
  const loadLedger = () => {
    let raw;
    try { raw = fs.readFileSync(ledgerFile, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return { merges: [] }; throw new Error(`ledger unreadable: ${(e && e.message) || e}`); }
    try { const l = JSON.parse(raw); return l && Array.isArray(l.merges) ? l : { merges: [] }; } catch { throw new Error('ledger file is corrupt — refusing to read (back it up + repair so merge history is not lost)'); }
  };
  // atomic (temp + rename on the same fs) so a crash mid-write can't truncate the ledger; THROWS on failure.
  const saveLedger = l => {
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    const tmp = `${ledgerFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(l, null, 2)}\n`);
    fs.renameSync(tmp, ledgerFile);
  };

  // run `command` against an isolated checkout of `branch` — the INDEPENDENT verification.
  const verifyBranch = async (branch, command, now) => {
    const dir = path.join(vbase, slug(branch) + '-' + slug(String(now || 'v')));
    await host.exec(`mkdir -p ${shq(vbase)}`, { timeoutMs: 15000 });
    const add = await host.exec(`git -C ${shq(repo)} worktree add --quiet --detach ${shq(dir)} ${shq(branch)}`, { timeoutMs: 120000 });
    // TRI-STATE: `ran` distinguishes "the tests RAN and were red" (a real regression → revert) from
    // "we could not even RUN them" (infra: checkout/runner failure → do NOT revert a good merge).
    if (!add.ok) return { ok: false, ran: false, reason: `could not check out ${branch} to verify: ${tail(add, 200)}` };
    let result;
    try {
      const run = await host.exec(`cd ${shq(dir)} && ${command}`, { timeoutMs });
      result = { ok: run.ok, ran: true, code: run.code, testTail: tail(run) };
    } catch (e) {
      result = { ok: false, ran: false, reason: `verification could not run: ${String((e && e.message) || e)}` };
    } finally {
      await host.exec(`git -C ${shq(repo)} worktree remove --force ${shq(dir)} ; git -C ${shq(repo)} worktree prune`, { timeoutMs: 30000 });
    }
    return result;
  };

  // merge `branch` into the live baseBranch — SAFE: refuse on a dirty tree, abort on conflict.
  const mergeBranch = async (branch, goal, now) => {
    const dirty = await host.exec(`git -C ${shq(repo)} status --porcelain`, { timeoutMs: 30000 });
    if (!dirty.ok) return { merged: false, reason: 'could not read the live tree status — refusing to auto-merge (fail closed)', branch };
    // `treeDirty` marks this refusal as NOT the change's fault — the branch is fine, the LIVE tree is
    // blocked by someone's uncommitted work. improve() maps it to a STAGED (ready-to-review) outcome.
    if (String(dirty.stdout || '').trim()) return { merged: false, treeDirty: true, reason: 'the live checkout has uncommitted changes — refusing to auto-merge (would risk clobbering work)', branch };
    // FAIL CLOSED on an unrecordable ledger: load it BEFORE merging so a corrupt/unwritable changelog blocks
    // the merge (never ship a change we cannot record for revert). A throw here = no merge happened.
    let l; try { l = loadLedger(); } catch (e) { return { merged: false, reason: `refusing to auto-merge — ${(e && e.message) || e} (a change we can't record in the changelog must not ship)`, branch }; }
    const before = (await host.exec(`git -C ${shq(repo)} rev-parse HEAD`, { timeoutMs: 15000 })).stdout.trim();
    const m = await host.exec(`git -C ${shq(repo)} merge --no-ff --no-edit -m ${shq(`self-improve: ${String(goal).slice(0, 90)}`)} ${shq(branch)}`, { timeoutMs: 120000 });
    if (!m.ok) {
      await host.exec(`git -C ${shq(repo)} merge --abort 2>/dev/null`, { timeoutMs: 30000 }); // never leave a half-merge
      return { merged: false, reason: `merge conflict — left ${branch} for manual review`, branch, baseBefore: before, conflict: true };
    }
    const mergeCommit = (await host.exec(`git -C ${shq(repo)} rev-parse HEAD`, { timeoutMs: 15000 })).stdout.trim();
    const id = `m-${slug(String(now || mergeCommit)).slice(0, 8)}-${mergeCommit.slice(0, 8)}`;
    l.merges.push({ id, goal: String(goal).slice(0, 200), branch, mergeCommit, baseBefore: before, baseBranch, mergedAt: String(now || ''), rolledBack: false });
    // Surface a failed ledger write LOUDLY — the merge is live but the UI can't see/revert it. The merge
    // commit message ("self-improve: <goal>") is the fallback recovery handle (git log --grep self-improve:).
    try { saveLedger(l); } catch (e) { return { merged: true, branch, mergeCommit, baseBefore: before, id, ledgerRecorded: false, reason: `MERGED but the changelog write FAILED (${(e && e.message) || e}) — it won't appear in the 🔧 changelog. Find it: git -C ${repo} log --grep "self-improve:"; revert: git -C ${repo} revert -m 1 ${mergeCommit}` }; }
    return { merged: true, branch, mergeCommit, baseBefore: before, id };
  };

  // THE LOOP. employExecutor({ goal }) → { branch } (the branch holding the implemented change), or null.
  // autoMerge=false → fork + implement + VERIFY, then STOP with a verified branch ready for review (the
  // safe default for a fresh deployment; flip it on once the loop has been watched + rollback is exposed).
  const improve = async ({ goal, successCommand, employExecutor, autoMerge = false, now } = {}) => {
    const g = String(goal || '').trim();
    if (!g) return { ok: false, merged: false, reason: 'a goal is required' };
    if (typeof employExecutor !== 'function') return { ok: false, merged: false, reason: 'no implementer wired' };
    // 1. FORK + IMPLEMENT (the executor works in its OWN isolated worktree and commits to a branch).
    let emp; try { emp = await employExecutor({ goal: g }); } catch (e) { return { ok: false, merged: false, attempted: true, reason: `implementer failed: ${String((e && e.message) || e)}` }; }
    const branch = emp && emp.branch;
    if (!branch) return { ok: true, merged: false, attempted: true, reason: 'the implementer produced no branch (nothing was changed)', detail: emp && emp.answer };
    // GUARD: an EMPTY branch (no diff vs the base) means nothing was actually implemented — never verify +
    //   stage/merge a no-op as a "verified improvement" (an executor that only NARRATES a change leaves the
    //   worktree clean → the branch equals the base → the unchanged code trivially passes the suite).
    const diff = await host.exec(`git -C ${shq(repo)} diff --quiet ${shq(baseBranch)}..${shq(branch)}`, { timeoutMs: 30000 });
    if (diff.ok) return { ok: true, merged: false, attempted: true, branch, empty: true, reason: 'the implementer produced an EMPTY branch (no change vs the base) — nothing was actually implemented', detail: emp && emp.answer };
    // 2. VERIFY INDEPENDENTLY — re-run the suite ourselves on the branch.
    const v = await verifyBranch(branch, String(successCommand || defaultTest), now);
    if (!v.ok) return { ok: true, merged: false, attempted: true, branch, verified: false, reason: v.reason || 'the change did not pass verification (not shown to be an improvement)', testTail: v.testTail };
    // 3. MERGE (safe) — only a verified-green, conflict-free change lands. Gated by autoMerge.
    if (!autoMerge) return { ok: true, merged: false, attempted: true, verified: true, branch, goal: g, readyToReview: true, reason: 'verified green — branch is ready for you to review + merge (auto-merge is off)' };
    const r = await mergeBranch(branch, g, now);
    // A DIRTY LIVE TREE is not a failure of the CHANGE: the branch is verified GREEN and kept intact —
    // the merge is merely blocked on the operator's uncommitted work. Surface it exactly like the
    // autoMerge-off path (readyToReview) so the caller records it as STAGED (no burned retry attempt)
    // and raises the 🔔 staged-review card, instead of attributing a "failed attempt" to a good change.
    if (!r.merged && r.treeDirty) return { ok: true, ...r, attempted: true, verified: true, goal: g, readyToReview: true, reason: `verified green — auto-merge deferred (${r.reason}). The branch is kept + staged for review; merge it from the 🔔 inbox once the live tree is clean.` };
    if (!r.merged) return { ok: true, ...r, attempted: true, verified: true, goal: g };
    // 4. POST-MERGE RE-VERIFY the MERGED live tree with the FULL default suite (NOT a weaker per-call
    //    command) — a change green IN ISOLATION can still break once merged (interaction with HEAD).
    const pv = await verifyBranch(baseBranch, String(defaultTest), now);
    if (pv.ok) return { ok: true, ...r, attempted: true, verified: true, postVerified: true, goal: g };
    // INFRA failure (couldn't check out / runner died) is NOT a regression — do NOT revert a merge that
    // already passed isolated verify on the strength of a transient infra hiccup. Leave it live + surface it.
    if (!pv.ran) return { ok: false, ...r, attempted: true, verified: true, postVerifyInconclusive: true, goal: g, reason: `post-merge re-verify could NOT RUN (${pv.reason}); merge ${String(r.mergeCommit).slice(0, 8)} passed isolated verify and is LEFT LIVE (not reverted). Re-verify, or revert from the 🔧 changelog if needed.` };
    // RED post-merge (tests RAN and FAILED) → AUTO-REVERT. If the revert ALSO fails, the broken merge is
    // STILL LIVE — surface that LOUDLY (ok:false) with manual-revert instructions; never mask it as handled.
    const rb = await rollback({ id: r.id, now });
    if (!rb.ok) return { ok: false, merged: true, attempted: true, verified: true, postVerifyFailed: true, rolledBack: false, brokenMergeLive: true, branch, mergeCommit: r.mergeCommit, goal: g, reason: `CRITICAL: post-merge re-verify FAILED and the auto-revert ALSO FAILED (${rb.error || 'unknown'}) — the broken merge ${String(r.mergeCommit).slice(0, 8)} is STILL on ${baseBranch}. Revert manually: git -C <repo> revert -m 1 ${r.mergeCommit}`, testTail: pv.testTail };
    return { ok: true, attempted: true, verified: true, merged: false, revertedAfterMerge: true, rolledBack: true, branch, mergeCommit: r.mergeCommit, goal: g, reason: 'the MERGED tree failed post-merge re-verification — auto-reverted the merge', testTail: pv.testTail };
  };

  // ROLLBACK — revert an auto-merge by its ledger id (revert the merge commit; history preserved).
  const rollback = async ({ id, now } = {}) => {
    let l; try { l = loadLedger(); } catch (e) { return { ok: false, error: `cannot read the changelog to revert — ${(e && e.message) || e}` }; }
    const e = l.merges.find(x => x.id === id);
    if (!e) return { ok: false, error: `no merge ${id} in the ledger` };
    if (e.rolledBack) return { ok: true, alreadyRolledBack: true, id };
    const dirty = await host.exec(`git -C ${shq(repo)} status --porcelain`, { timeoutMs: 30000 });
    if (!dirty.ok) return { ok: false, error: 'could not read live tree status — refusing rollback (fail closed)' };
    if (String(dirty.stdout || '').trim()) return { ok: false, error: 'live checkout dirty — commit/stash before rollback' };
    const rev = await host.exec(`git -C ${shq(repo)} revert --no-edit -m 1 ${shq(e.mergeCommit)}`, { timeoutMs: 60000 });
    if (!rev.ok) { await host.exec(`git -C ${shq(repo)} revert --abort 2>/dev/null`, { timeoutMs: 20000 }); return { ok: false, error: `revert failed (conflict): ${tail(rev, 300)}` }; }
    // the revert COMMIT already landed — if marking the ledger fails, say so (don't claim a clean undo).
    e.rolledBack = true; e.rolledBackAt = String(now || '');
    try { saveLedger(l); } catch (err) { return { ok: true, id, revertedMerge: e.mergeCommit, goal: e.goal, ledgerUpdateFailed: true, warning: `reverted on disk, but the changelog could not be updated (${(err && err.message) || err}) — it may still show as revertable` }; }
    return { ok: true, id, revertedMerge: e.mergeCommit, goal: e.goal };
  };

  const listMerges = ({ limit = 20 } = {}) => loadLedger().merges.slice(-limit).reverse();

  return harden({ improve, rollback, listMerges, verifyBranch, mergeBranch, ledgerFile, repo, baseBranch });
};
harden(makeSelfImprover);
