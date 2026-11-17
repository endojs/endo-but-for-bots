import json, sys, collections
ns={}
src=open('../../../probes/test262-sweep/ih_alone.py').read()
exec('def verdict(c):'+src.split('def verdict(c):',1)[1].split('\nV = ',1)[0], ns)
d=json.load(open('/home/user/endo-but-for-bots/rust/engine/target/test262-report-oracle-off/report.json'))
on={c['path']+'|'+str(c.get('mode')):c for c in json.load(open('/home/user/endo-but-for-bots/rust/engine/target/test262-report/report.json'))['cases']}
for x in d['cases']:
    if any(x['path'].startswith(p) for p in sys.argv[1:]):
        v=ns['verdict'](x)
        if v in ('fail','unsupported'):
            print(v, x['path'], x.get('mode'), (x['reason'] or '')[:230])
