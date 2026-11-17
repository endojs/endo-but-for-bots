import json,sys,re,collections
r=json.load(open('/home/user/endo-but-for-bots/rust/engine/target/test262-report/report.json'))
pat=re.compile(sys.argv[1])
c=collections.Counter(); ex=collections.defaultdict(list)
for k in r['cases']:
    if pat.search(k['path']):
        c[k['category']]+=1; ex[k['category']].append((k['path'],k.get('reason')))
print(dict(c))
show=sys.argv[2] if len(sys.argv)>2 else 'ironhorse-failure'
for p,rs in ex[show][:int(sys.argv[3]) if len(sys.argv)>3 else 8]: print('  ',p,'|',(rs or '')[:160])
