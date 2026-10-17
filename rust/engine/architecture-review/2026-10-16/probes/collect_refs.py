"""List probe files referenced by maps, verification records and lenses."""
import os, re, sys, json
S = sys.argv[1]
P = os.path.join(S, 'probes')
texts = []
for d in ['maps', 'lenses', 'synthesis', 'verify']:
    root = os.path.join(S, d)
    if not os.path.isdir(root): continue
    for f in os.listdir(root):
        fp = os.path.join(root, f)
        if os.path.isfile(fp): texts.append(open(fp, encoding='utf-8', errors='replace').read())
blob = '\n'.join(texts)
refs = set()
# absolute scratch paths, $SCRATCH-relative paths, and probes/<region>/<file> relative paths
for m in re.finditer(r'(?:' + re.escape(P) + r'|\$SCRATCH/review/probes|probes)/([A-Za-z0-9_.\-]+(?:/[A-Za-z0-9_.\-{},]+)*)', blob):
    refs.add(m.group(1).rstrip('.,;:)'))
files, dirs, missing = set(), set(), []
for r in sorted(refs):
    full = os.path.join(P, r)
    if os.path.isfile(full): files.add(r)
    elif os.path.isdir(full): dirs.add(r)
    else: missing.append(r)
SRC = ('.js', '.rs', '.py', '.sh', '.c', '.h', '.mjs', '.txt', '.md', '.out', '.log', '.json', '.tsv', '.node', '.ih', '.err')
sel = set()
for f in files: sel.add(f)
for d in dirs:
    for dp, dn, fn in os.walk(os.path.join(P, d)):
        for x in fn:
            rel = os.path.relpath(os.path.join(dp, x), P)
            sel.add(rel)
keep, skip = [], []
for f in sorted(sel):
    full = os.path.join(P, f)
    sz = os.path.getsize(full)
    if f.endswith(SRC) and sz <= 64 * 1024 and not f.startswith('verify/') or (f.startswith('verify/') and f.endswith(SRC) and sz <= 64*1024):
        keep.append((f, sz))
    else:
        skip.append((f, sz))
json.dump({'keep': keep, 'skip': skip, 'missing': missing}, open(os.path.join(S, 'probe-selection.json'), 'w'), indent=1)
print('refs', len(refs), 'files', len(files), 'dirs', len(dirs), 'missing', len(missing))
print('keep', len(keep), sum(s for _, s in keep), 'skip', len(skip), sum(s for _, s in skip))
