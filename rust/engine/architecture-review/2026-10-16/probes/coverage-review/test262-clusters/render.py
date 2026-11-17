import json, re, collections
np = json.load(open('nonpass.json')); L = json.load(open('labels.json'))
v = {}
exec(open('../../../probes/test262-sweep/ih_alone.py').read().split('V = [')[0].replace("d = json.load(open(sys.argv[1]))", "d={'cases':[]}"), v)
short = [
 (r'^NVAL-6/7 Temporal', 'NVAL-6/NVAL-7'), (r'^BOOT-7', 'BOOT-7'), (r'^CMP-12', 'CMP-12'), (r'^RGX-1', 'RGX-1'),
 (r'^T262-2', 'T262-2'), (r'^import defer', 'import-defer/source-phase proposal [SF row]'), (r'^NVAL-8', 'NVAL-8/NVAL-5'),
 (r'^T262-9', 'T262-9'), (r'^CORE-2', 'CORE-2/FN-1'), (r'^absent: Intl.DurationFormat', 'DurationFormat absent [SF row]'),
 (r'^absent: Promise.allKeyed', 'await-dictionary absent [SF row]'), (r'^absent: Annex B String', 'Annex B HTML methods absent [SF row]'),
 (r'^RGX-2', 'RGX-2'), (r'^absent: Intl.RelativeTimeFormat', 'RelativeTimeFormat absent [SF row]'),
 (r'^absent: Iterator.zip', 'joint-iteration absent [SF row]'), (r'^absent: Iterator.prototype.chunks', 'iterator-chunking absent [SF row]'),
 (r'^absent: immutable', 'immutable-arraybuffer absent [SF row]'), (r'^absent: Intl.Locale info', 'Intl.Locale-info absent [SF row]'),
 (r'^absent: Intl.DisplayNames', 'DisplayNames absent [SF row]'), (r'^absent: Iterator.prototype.includes', 'iterator-includes absent [SF row]'),
 (r'^absent: Iterator.prototype.join', 'Iterator.prototype.join absent [SF row]'), (r'^NOBJ-12', 'NOBJ-12'), (r'^NOBJ-13', 'NOBJ-13'),
 (r'^absent: legacy RegExp', 'legacy-regexp absent [SF row]'), (r'^NEW await in module', 'NEW-3'), (r'^NEW PutValue', 'NEW-2'),
 (r'^NEW RegExp.prototype.compile', 'NEW-4'), (r'^NEW error-stack', 'NEW-6'), (r'^NEW strict', 'NEW-1'),
 (r'^absent: %Iter', 'NEW-5b'), (r'^decorators', 'decorators [SF row]'), (r'^CORE-3', 'CORE-3/NVAL-4'),
 (r'^Intl NotImplemented', 'Intl NotImplemented [SF rows]'), (r'^Annex B.1.2', 'Annex B.1.2 regexp (regexp map note)'),
 (r'^Temporal/Intl calendars', 'NVAL-7 calendars'), (r'^HARNESS', 'completion-coercion artifact'), (r'^OTHER', 'misc'),
 (r'^NEW Annex B call', 'CMP-12 gap: B.3.? call targets'),
]
def s(l):
    for pat, rep in short:
        if re.search(pat, l): return rep
    return l
def norm(r): return re.sub(r'«[^»]*»', '«…»', re.sub(r'"[^"]*"', '"…"', r or ''))[:140]
g = collections.defaultdict(collections.Counter)
for c in np: g[('/'.join(c['path'].split('/')[:3]), v['verdict'](c), norm(c['reason']))][s(L[c['path']])] += 1
print('| n | area | verdict | sweep reason | explanation |'); print('|---:|---|---|---|---|')
for k, cnt in sorted(g.items(), key=lambda kv: -sum(kv[1].values())):
    n = sum(cnt.values())
    if n < 10: continue
    reason = k[2]
    if reason.startswith('ironhorse failed'): reason = 'IH failed assertion, oracle passed'
    if reason.startswith('async: Test262:AsyncTestFailure:Test262Error'): reason = 'async reject-reason mismatch'
    if reason.startswith('async: Test262:AsyncTestFailure:TypeError'): reason = 'async TypeError call: not a function'
    print(f'| {n} | {k[0]} | {k[1]} | {reason} | ' + ', '.join(f'{lab} {m}' for lab, m in cnt.most_common()) + ' |')
