// fork-model.js — the pure data-model behind retry-as-fork. No DOM, no network: it operates on the chat's
// transcript array (tx) in place so the client can keep using its `activeTx` global directly, and so the
// branching invariants are unit-testable without a browser.
//
// THE MODEL. Retrying a USER turn forks the conversation AT that turn: the prompt + everything below it
// becomes one branch; a fresh (maybe edited) prompt starts a new branch, and everything below the bubble
// is cleared. Forks live on the user tx entry as `m.forks = [{ prompt, tail }]` + `m.forkIx`, where `tail`
// is that branch's whole continuation (the answer + any later turns, which may themselves carry forks).
// The ACTIVE branch's tail is NOT duplicated into m.forks — it lives in tx[uIx+1..]; we sync it back into
// m.forks[m.forkIx] right before switching away. `m.text` always mirrors the active branch's prompt.

// stash the live branch (prompt + tail) into m.forks[m.forkIx] before we switch off it.
const syncActive = (tx, uIx, m) => { m.forks[m.forkIx] = { prompt: m.text, tail: tx.slice(uIx + 1) }; };

// Fork at the user turn uIx with `prompt`: stash the current branch, push a fresh empty branch, truncate
// everything below the bubble. The caller then re-runs `prompt`; the answer grows the new branch's tail.
export const forkRetry = (tx, uIx, prompt) => {
  const m = tx[uIx];
  if (!m || m.who !== 'you') return false;
  if (!m.forks) { m.forks = [{ prompt: m.text, tail: tx.slice(uIx + 1) }]; m.forkIx = 0; }
  else syncActive(tx, uIx, m);
  m.forks.push({ prompt, tail: [] });
  m.forkIx = m.forks.length - 1;
  m.text = prompt;
  tx.length = uIx + 1; // clear below — the new branch grows from here
  return true;
};

// Page to another fork of the user turn uIx: sync the live branch, advance forkIx (wrapping), then restore
// the chosen branch's prompt + its whole continuation. Returns false when there's nothing to page.
export const forkPage = (tx, uIx, delta) => {
  const m = tx[uIx];
  if (!m || !m.forks || m.forks.length < 2) return false;
  syncActive(tx, uIx, m);
  m.forkIx = (m.forkIx + delta + m.forks.length) % m.forks.length;
  const f = m.forks[m.forkIx];
  m.text = f.prompt;
  tx.length = uIx + 1;
  for (const e of f.tail) tx.push(e);
  return true;
};

// how many forks a user turn has, and which is active (1-based count for display).
export const forkCount = m => (m && m.forks ? m.forks.length : 1);
export const forkIndex = m => (m && m.forks ? m.forkIx : 0);
