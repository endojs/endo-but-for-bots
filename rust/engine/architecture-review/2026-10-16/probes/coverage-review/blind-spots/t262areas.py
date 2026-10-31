import json, sys, collections, importlib.util
spec = importlib.util.spec_from_file_location('ih', '../../../probes/test262-sweep/ih_alone.py')
src = open(spec.origin).read()
verdict_src = src.split('def verdict(c):',1)[1].split('\nV = ',1)[0]
ns={}
exec('def verdict(c):'+verdict_src, ns)
verdict=ns['verdict']
d=json.load(open('/home/user/endo-but-for-bots/rust/engine/target/test262-report-oracle-off/report.json'))
prefixes=sys.argv[1:]
for p in prefixes:
    c=collections.Counter(); fails=collections.Counter()
    for x in d['cases']:
        if x['path'].startswith(p):
            v=verdict(x); c[v]+=1
            if v in ('fail','unsupported'): fails[(v, (x['reason'] or '')[:100])]+=1
    print(p, dict(c))
    for k,v in fails.most_common(4): print('    ',v,k)
