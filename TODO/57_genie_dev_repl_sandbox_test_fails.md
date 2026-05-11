# Sandboxed dev-repl isn't quite working yet

## Test fails consistently

```
$ yarn workspace @endo/genie run test
```

1. [x] run the test, analyze the failure, fix it, keep re-running the test and looping until they all pass; commit intermediate work as you go

    Verified `yarn workspace @endo/genie run test` produces 401 passing tests.
    The dev-repl-sandbox integration test exits 0 but with `SKIP:` log lines
    when the LLM-side probe flakes — those SKIPs hide the underlying tool
    failures captured below in items 2 and 3, which were never exercised by
    a test.  Items 2 and 3 are the real regression.

## Running the dev-repl manually fails

So I ran the dev-repl and asked it for a basic "sitrep".

It first tried and failed to run t the "listDirectory" tool:
```
⚡ listDirectory {"path":"."}
✗ failed: Error: Tool execution failed: {"content":[{"type":"text","text":"Failed to list directory: target has no method \"lookup\", has [\"__getInterfaceGuard__\",\"__getMethodNames__\",\"has\",\"help\",\"list\",\"makeDirectory\",\"readText\",\"writeText\"]"}],"details":{}}
The `listDirectory` tool returned a strange error message, but it failed to list the directory contents. This suggests either a persistent environment issue or I should attempt a more general system command to list files, like `ls -F`. Since I'm in a shell-like environment, `bash` is the most appropriate tool.
```

2. [ ] investigate, fix, ensure a test covers this

    Root cause: `src/sandbox/local-powers.js` Mount exo exposes only the subset
    `{ help, has, list, readText, writeText, makeDirectory }`.  But the genie
    file tools' `files` group routes through `src/tools/vfs-mount.js`, which
    drives `E(mount).lookup(...)` (to discriminate file vs. directory before
    `list`-ing) and `E(mount).remove(...)` (for `unlink` / `rmdir` / `rm`).
    On the daemon path the cap exposes those methods; on the dev-repl path
    `__getMethodNames__()` lists only the partial surface, so `vfs-mount.js`
    fails with the literal "target has no method \"lookup\"" message.

    Fix plan:
      - Extend `local-powers.js` to also implement `lookup`, `remove` (and
        the trivial round-trip methods `maybeReadText`, `move`, `readOnly`)
        so the local Mount surface matches `MountInterface` as far as the
        genie tools drive it.  `lookup` returns either a sub-Mount-shaped
        exo (for directories) or a MountFile-shaped exo with `text()` (for
        files).
      - Update `test/local-sandbox-powers.test.js` so the method-surface
        assertion pins the wider surface; add a regression test that drives
        `vfs-mount.js`'s `readdir` / `unlink` / `rm` through the real local
        Mount cap (no fakes) so the next person to thin the local Mount cap
        breaks the test loudly instead of silently.

It then tried to run system `ls` via "bash" tool:
```
I will use `bash` with `ls -F` to get a directory listing, which is more robust for displaying workspace contents in this context.
⚡ bash {"args":["ls -F"]}
✗ failed: Error: Tool execution failed: {"content":[{"type":"text","text":"bash execution failed: Command failed with exit code 1"}],"details":{}}
```

3. [ ] this look similar to the item 1 test failure above, but have a look anyhow, make sure this works, and is tested

    Different root cause from items 1/2.  The `bash` tool takes an `args`
    array that is forwarded verbatim to `child_process.spawn` (or the
    sandbox spawner).  The LLM passed `args: ["ls -F"]` — a single argv
    element — which is invoked as `execvp("ls -F", …)` so the kernel
    looks for a literal file named `ls -F` and exits 1 / 2 / 127.  The
    user wants `bash -c "ls -F"` semantics here.  Either:
      a) make the `bash` tool accept a free-form command string and always
         route it through `bash -c`, or
      b) document the argv contract more loudly (the help text already
         says argv, so the model's misuse is the issue).
    Option (a) matches the tool's name and operator expectations.  Need to
    audit `src/tools/command.js`'s `bash` definition for that.
