import json, collections, re, sys
rows = [json.loads(l) for l in open('sync-all.jsonl')]
bycase = collections.defaultdict(list)
for r in rows: bycase[r['path']].append(r)
reason = {c['path']: c['reason'] for c in json.load(open('nonpass.json'))}
def norm(m):
    m = re.sub(r'«[^»]*»', '«…»', m); m = re.sub(r'"[^"]*"', '"…"', m); m = re.sub(r"'[^']*'", "'…'", m)
    m = re.sub(r'line \d+', 'line N', m); m = re.sub(r'\d+', 'N', m)
    return m[:110]
stat = collections.Counter()
fails = []
for p, rs in bycase.items():
    allok = all(r['ok'] for r in rs)
    stat['pass-one-script' if allok else 'fail-one-script'] += 1
    if not allok:
        bad = [r for r in rs if not r['ok']][0]
        fails.append((p, bad))
print(stat)
if len(sys.argv) > 1 and sys.argv[1] == 'passes':
    g = collections.Counter('/'.join(p.split('/')[:3]) + ' | ' + reason[p] for p, rs in bycase.items() if all(r['ok'] for r in rs))
    for k, v in g.most_common(): print(v, k)
else:
    g = collections.Counter(('/'.join(p.split('/')[:3]), norm(b['msg'])) for p, b in fails)
    for (a, m), v in g.most_common():
        if v >= int(sys.argv[2] if len(sys.argv) > 2 else 3): print(v, a, '|', m)
