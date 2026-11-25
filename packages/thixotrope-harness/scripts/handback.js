// @ts-check
/**
 * The project preset's hand-back (F4, round 4): how a child's commits reach
 * its parent's checkout. A child's checkout is its own, and an
 * `askSubagent` answer is cut at about 31,000 characters, so the parent
 * attaches its own `shell` to the child as `parent-shell` at the spawn and
 * the child writes its commits there as a base64 git bundle in numbered
 * pieces under `.git/handback/<child HEAD>/`.
 *
 * Nothing lives in an exec scope: the shell is the environments manager's
 * object, so a parent exec deadline (which retires its exec vat and
 * everything published there) leaves it working. The exec code is
 * idempotent: the bundle of one HEAD is made once (`.git/hb-<HEAD>`,
 * written through a temporary name), each piece is written through a
 * temporary name and renamed, and a rerun counts the pieces already there
 * and goes on from the next, so a run cut by the child's own exec deadline
 * is simply run again. A child with no commits since its seed gets "no
 * commits" and writes nothing. The bundle's base is the first commit of
 * HEAD's reflog, which a seeded checkout's creation sets to the seed
 * commit (`initWorkspaceRepository` resets to it), and so one the parent
 * holds. A piece is 2,500 characters: one read (a command's stdout is cut
 * at 2,560) and one write (a call's arguments to another vat are limited
 * to 12,288 bytes, counted at about three per character). So a change of
 * N bytes takes about N / 940 piece writes, each a shell call each way; a
 * large change is handed back over several runs, each resuming.
 */

/** The child's exec code, run unchanged (also to resume). */
export const handBackExec = [
  'const sh = await E(powers).lookup("shell"), to = await E(powers).lookup("parent-shell");',
  'const run = (s, c, ...a) => E(s).runCommand("sh", ["-c", c, "sh", ...a.map(String)]);',
  'const r = await run(sh, "b=$(git reflog --format=%H HEAD | tail -n 1) h=$(git rev-parse HEAD) && [ $b != $h ] || exit 0; f=.git/hb-$h; [ -s $f ] || { git bundle create $f.b $b..HEAD && base64 < $f.b | tr -d \\"\\n\\" > $f.t && mv $f.t $f; } && echo $h $(wc -c < $f)");',
  'if (r.exitCode) return r.stderr; const [h, n] = r.stdout.split(" "); if (!n) return "no commits";',
  'for (let i = 2500 * (await run(to, "mkdir -p .git/handback/$1 && ls .git/handback/$1 | grep -c ^1", h)).stdout; i < +n; i += 2500) {',
  'const p = await run(sh, "cut -c $1-$2 .git/hb-$3", i + 1, i + 2500, h); if (p.exitCode) return p.stderr;',
  'const w = await run(to, "cd .git/handback/$1 && printf %s \\"$2\\" > t && mv t $3", h, p.stdout.trim(), 1e5 + i / 2500); if (w.exitCode) return w.stderr; }',
  'return "handed back " + h;',
].join(' ');

/** The parent's shell script: `sh -c <this> sh COMMIT NAME`. */
export const handBackFetch =
  'd=.git/handback/$1; [ -d $d ] || { echo no hand-back of $1; exit 1; }; cat $d/1* | base64 -d > $d.b && git fetch -q $d.b +HEAD:refs/heads/$2 && [ $(git rev-parse $2) = $1 ] && git log --oneline main..$2';
