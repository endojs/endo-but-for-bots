// @ts-check

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

/** @import { ToolRecord } from '../src/types.js' */

import test from 'ava';
import { E } from '@endo/far';

import { makeGitTool } from '../src/git-tool.js';
import { makeMountReadTool } from '../src/mount-fs.js';
import {
  makeMountWriteTool,
  makeMountListTool,
  makeMountStatTool,
  makeGitStatusTool,
  makeGitRemoteTool,
  makeGitFilesystemAtTool,
} from '../src/north-star-tools.js';
import {
  prepareGuestPowers,
  prepareGitWorkspace,
} from './helpers/daemon-petstore.js';

/**
 * The north-star forcing-function test.
 *
 * This is a CONTRACT, not a passing test. It drives the entire north-star
 * agent loop at the `@endo/agent-tools` *tool* layer, over ONE shared
 * workspace, exactly tool-to-tool:
 *
 *   1. provision a workspace — a real native-git-backed `Git` + daemon
 *      `EndoMount` over one physical root (`prepareGitWorkspace`), and a real
 *      daemon-backed guest petstore for the petname round-trip
 *      (`prepareGuestPowers`);
 *   2. EDIT a file through the FS write tool;
 *   3. call the `status` tool — plain-JSON rows whose changed entries are bound
 *      to PETNAMES via the return-side-wire-ify call `storeValue(cap, petname)`;
 *   4. call `add` with a petname (this tool EXISTS on this branch — used for
 *      real, resolving the petname back to the live cap via the petstore);
 *   5. call `commit` (EXISTS — used for real);
 *   6. push through a bounded `GitRemote` tool;
 *   7. call `filesystemAt('HEAD~1')` → a read-only `Filesystem` bound to a
 *      petname;
 *   8. read the prior version of the file through an FS read tool over that
 *      view.
 *
 * Steps 2, 3, 6, 7, 8 drive the Phase-1 STUBS in `src/north-star-tools.js`,
 * which throw `not implemented: <tool>`. The follow-on builds make this test
 * go green one tool at a time. It is wrapped in `test.failing` (ava's
 * expected-failure) so the deliberate red lives in the suite without breaking
 * CI: ava reports a `test.failing` body that throws as a *pass*, and would fail
 * CI only if the body unexpectedly stopped throwing — i.e. once the contract is
 * fully implemented, at which point this wrapper is flipped to `test.serial`.
 *
 * Forks a full daemon (for the guest petstore) and shares filesystem state, so
 * it is serial via `test.serial.failing` with both helpers' teardowns.
 */

/**
 * @param {ToolRecord[]} tools
 * @returns {(name: string) => ToolRecord}
 */
const byNameOf = tools => name => {
  const found = tools.find(tool => tool.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

test.serial.failing(
  'north-star loop: edit, status, add, commit, push, filesystemAt(HEAD~1), read prior',
  async t => {
    t.timeout(120_000);

    // (1) Provision the shared substrate and the petstore powers.
    const powers = await prepareGuestPowers(t);
    const { git, mount } = await prepareGitWorkspace(t, {
      fileName: 'README.md',
      content: 'v1\n',
    });

    // The Git tool set: `add` / `commit` are real (they exist on this branch);
    // `status` and `filesystemAt` are the deferred return-side-wire-ify tools
    // these stubs introduce.
    const gitTools = byNameOf(makeGitTool(git, powers));
    const addTool = gitTools('add');
    const commitTool = gitTools('commit');
    const statusTool = makeGitStatusTool(git, powers);
    const filesystemAtTool = makeGitFilesystemAtTool(git, powers);

    // The FS tool surface over the mount's worktree view.
    const worktree = await E(mount).readOnly();
    const writeTool = makeMountWriteTool(/** @type {any} */ (mount));
    const listTool = makeMountListTool(/** @type {any} */ (worktree));
    const statTool = makeMountStatTool(/** @type {any} */ (worktree));
    void listTool;
    void statTool;

    // (2) EDIT README.md through the FS write tool. (Stub → fails here first.)
    await writeTool.invoke({ path: 'README.md', content: 'v2\n' });

    // (3) status: plain-JSON rows, changed entries bound to petnames.
    const statusResult =
      /** @type {{ rows: Array<{ path: string, petname: string }> }} */ (
        await statusTool.invoke({})
      );
    const readmeRow = statusResult.rows.find(row => row.path === 'README.md');
    t.truthy(readmeRow, 'status should report README.md as changed');
    const { petname } = /** @type {{ petname: string }} */ (readmeRow);
    t.is(typeof petname, 'string');

    // (4) add the changed entry BY PETNAME — the real capref[] tool resolves
    // the petname back to the live EndoMountEntry via the guest petstore.
    await addTool.invoke({ arg0: [petname] });

    // (5) commit for real.
    const commit = /** @type {{ oid?: string }} */ (
      await commitTool.invoke({ arg0: 'north-star: bump README to v2' })
    );
    t.regex(commit.oid || '', /^[0-9a-f]{40,64}$/, 'commit returns a new oid');

    // (6) push through the bounded GitRemote tool. The remote here is a
    // policy-bound GitRemote the host would have minted; the loop only needs
    // the verb surface. (Stub.)
    const remoteTools = byNameOf(
      makeGitRemoteTool(
        // A real GitRemote is minted by the host from `git`; the contract under
        // test is the tool wiring, so the implementing build supplies the live
        // remote here. Until then the push stub throws.
        /** @type {any} */ (git),
      ),
    );
    await remoteTools('gitPush').invoke({});

    // (7) filesystemAt('HEAD~1'): a read-only Filesystem bound to a petname.
    const fsResult = /** @type {{ ref: string, petname: string }} */ (
      await filesystemAtTool.invoke({ ref: 'HEAD~1' })
    );
    t.is(fsResult.ref, 'HEAD~1');
    const priorFsPetname = fsResult.petname;
    t.is(typeof priorFsPetname, 'string');

    // (8) read the PRIOR version of README.md through an FS read tool over the
    // historical view. The agent resolves the bound Filesystem petname and
    // drives a read tool over it; the prior content was 'v1\n'.
    const priorFs = await E(powers).lookup(priorFsPetname);
    const priorReadTool = makeMountReadTool(/** @type {any} */ (priorFs));
    const prior = await priorReadTool.execute({ path: 'README.md' });
    t.is(prior, 'v1\n', 'HEAD~1 view reads the pre-edit content');
  },
);
