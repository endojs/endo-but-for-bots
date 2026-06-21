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
  const loadLedger = () => { try { return JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); } catch { return { merges: [] }; } };
  const saveLedger = l => { try { fs.mkdirSync(path.dirname(ledgerFile), { recursive: true }); fs.writeFileSync(ledgerFile, `${JSON.stringify(l, null, 2)}\n`); } catch { /* best effort */ } };

  // run `command` against an isolated checkout of `branch` — the INDEPENDENT verification.
  const verifyBranch = async (branch, command, now) => {
    const dir = path.join(vbase, slug(branch) + '-' + slug(String(now || 'v')));
    await host.exec(`mkdir -p ${shq(vbase)}`, { timeoutMs: 15000 });
    const add = await host.exec(`git -C ${shq(repo)} worktree add --quiet --detach ${shq(dir)} ${shq(branch)}`, { timeoutMs: 120000 });
    if (!add.ok) return { ok: false, reason: `could not check out ${branch} to verify: ${tail(add, 200)}` };
    let result;
    try {
      const run = await host.exec(`cd ${shq(dir)} && ${command}`, { timeoutMs });
      result = { ok: run.ok, code: run.code, testTail: tail(run) };
    } finally {
      await host.exec(`git -C ${shq(repo)} worktree remove --force ${shq(dir)} ; git -C ${shq(repo)} worktree prune`, { timeoutMs: 30000 });
    }
    return result;
  };

  // merge `branch` into the live baseBranch — SAFE: refuse on a dirty tree, abort on conflict.
  const mergeBranch = async (branch, goal, now) => {
    const dirty = await host.exec(`git -C ${shq(repo)} status --porcelain`, { timeoutMs: 30000 });
    if (dirty.ok && String(dirty.stdout || '').trim()) return { merged: false, reason: 'the live checkout has uncommitted changes — refusing to auto-merge (would risk clobbering work)', branch };
    const before = (await host.exec(`git -C ${shq(repo)} rev-parse HEAD`, { timeoutMs: 15000 })).stdout.trim();
    const m = await host.exec(`git -C ${shq(repo)} merge --no-ff --no-edit -m ${shq(`self-improve: ${String(goal).slice(0, 90)}`)} ${shq(branch)}`, { timeoutMs: 120000 });
    if (!m.ok) {
      await host.exec(`git -C ${shq(repo)} merge --abort 2>/dev/null`, { timeoutMs: 30000 }); // never leave a half-merge
      return { merged: false, reason: `merge conflict — left ${branch} for manual review`, branch, baseBefore: before, conflict: true };
    }
    const mergeCommit = (await host.exec(`git -C ${shq(repo)} rev-parse HEAD`, { timeoutMs: 15000 })).stdout.trim();
    const l = loadLedger();
    const id = `m-${slug(String(now || mergeCommit)).slice(0, 8)}-${mergeCommit.slice(0, 8)}`;
    l.merges.push({ id, goal: String(goal).slice(0, 200), branch, mergeCommit, baseBefore: before, baseBranch, mergedAt: String(now || ''), rolledBack: false });
    saveLedger(l);
    return { merged: true, branch, mergeCommit, baseBefore: before, id };
  };

  // THE LOOP. employExecutor({ goal }) → { branch } (the branch holding the implemented change), or null.
  // autoMerge=false → fork + implement + VERIFY, then STOP with a verified branch ready for review (the
  // safe default for a fresh deployment; flip it on once the loop has been watched + rollback is exposed).
  const improve = async ({ goal, successCommand, employExecutor, autoMerge = true, now } = {}) => {
    const g = String(goal || '').trim();
    if (!g) return { ok: false, merged: false, reason: 'a goal is required' };
    if (typeof employExecutor !== 'function') return { ok: false, merged: false, reason: 'no implementer wired' };
    // 1. FORK + IMPLEMENT (the executor works in its OWN isolated worktree and commits to a branch).
    let emp; try { emp = await employExecutor({ goal: g }); } catch (e) { return { ok: false, merged: false, attempted: true, reason: `implementer failed: ${String((e && e.message) || e)}` }; }
    const branch = emp && emp.branch;
    if (!branch) return { ok: true, merged: false, attempted: true, reason: 'the implementer produced no branch (nothing was changed)', detail: emp && emp.answer };
    // 2. VERIFY INDEPENDENTLY — re-run the suite ourselves on the branch.
    const v = await verifyBranch(branch, String(successCommand || defaultTest), now);
    if (!v.ok) return { ok: true, merged: false, attempted: true, branch, verified: false, reason: v.reason || 'the change did not pass verification (not shown to be an improvement)', testTail: v.testTail };
    // 3. MERGE (safe) — only a verified-green, conflict-free change lands. Gated by autoMerge.
    if (!autoMerge) return { ok: true, merged: false, attempted: true, verified: true, branch, goal: g, readyToReview: true, reason: 'verified green — branch is ready for you to review + merge (auto-merge is off)' };
    const r = await mergeBranch(branch, g, now);
    return { ok: true, ...r, attempted: true, verified: true, goal: g };
  };

  // ROLLBACK — revert an auto-merge by its ledger id (revert the merge commit; history preserved).
  const rollback = async ({ id, now } = {}) => {
    const l = loadLedger(); const e = l.merges.find(x => x.id === id);
    if (!e) return { ok: false, error: `no merge ${id} in the ledger` };
    if (e.rolledBack) return { ok: true, alreadyRolledBack: true, id };
    const dirty = await host.exec(`git -C ${shq(repo)} status --porcelain`, { timeoutMs: 30000 });
    if (dirty.ok && String(dirty.stdout || '').trim()) return { ok: false, error: 'live checkout dirty — commit/stash before rollback' };
    const rev = await host.exec(`git -C ${shq(repo)} revert --no-edit -m 1 ${shq(e.mergeCommit)}`, { timeoutMs: 60000 });
    if (!rev.ok) { await host.exec(`git -C ${shq(repo)} revert --abort 2>/dev/null`, { timeoutMs: 20000 }); return { ok: false, error: `revert failed (conflict): ${tail(rev, 300)}` }; }
    e.rolledBack = true; e.rolledBackAt = String(now || ''); saveLedger(l);
    return { ok: true, id, revertedMerge: e.mergeCommit, goal: e.goal };
  };

  const listMerges = ({ limit = 20 } = {}) => loadLedger().merges.slice(-limit).reverse();

  return harden({ improve, rollback, listMerges, verifyBranch, mergeBranch, ledgerFile, repo, baseBranch });
};
harden(makeSelfImprover);
