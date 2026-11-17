"""Which in-scope source files does no map (or verification record) mention?"""
import os, re, subprocess, json, collections, sys
REPO = '/home/user/endo-but-for-bots'
S = sys.argv[1]
files = subprocess.run(['git', '-C', REPO, 'ls-files', 'rust/engine', 'rust/endo/src/ironhorse_engine.rs',
                        'rust/endo/ironhorse-store-sqlite', 'rust/thixotrope-ironhorse-worker'],
                       capture_output=True, text=True).stdout.split()
files = [f for f in files if f.endswith(('.rs', '.c', '.h', '.py', '.sh', '.toml', '.yml'))
         and '/architecture-review/' not in f and '/target/' not in f]
blob = ''
for d in ['maps', 'verify', 'lenses', 'synthesis']:
    for dp, dn, fn in os.walk(os.path.join(S, d)):
        for f in fn:
            if f.endswith(('.md', '.json')):
                blob += open(os.path.join(dp, f), encoding='utf-8', errors='replace').read()
def mentioned(path):
    # match by the path suffix beyond the crate dir, or by basename+crate
    parts = path.split('/')
    for k in range(len(parts) - 1, 0, -1):
        suffix = '/'.join(parts[-k:])
        if k >= 2 and suffix in blob:
            return True
    return False
unread = [f for f in files if not mentioned(f)]
lines = {}
for f in files:
    try: lines[f] = sum(1 for _ in open(os.path.join(REPO, f), encoding='utf-8', errors='replace'))
    except Exception: lines[f] = 0
tot = sum(lines.values()); un = sum(lines[f] for f in unread)
print(f'in-scope files {len(files)} ({tot} lines); never mentioned {len(unread)} ({un} lines)')
by = collections.defaultdict(lambda: [0, 0])
for f in unread:
    key = '/'.join(f.split('/')[:3])
    by[key][0] += 1; by[key][1] += lines[f]
for k, (n, l) in sorted(by.items(), key=lambda kv: -kv[1][1]):
    print(f'{l:7} lines {n:4} files  {k}')
json.dump({'unread': [(f, lines[f]) for f in sorted(unread, key=lambda f: -lines[f])]}, open(os.path.join(S, 'probes', 'coverage', 'writer', 'unread.json'), 'w'), indent=1)
