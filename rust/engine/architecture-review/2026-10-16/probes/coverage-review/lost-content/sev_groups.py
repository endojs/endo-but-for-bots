import json,re,glob,os
led={x['id']:x for x in json.load(open('ledger.json'))}
ID=r'(?:CMP|INT|RGX|SNI|SNS|T262|BOOT|CORE|FN|MEM|NOBJ|NVAL|PROP)-(?:NEW-)?\d+'
merge={'NOBJ-14':'medium','T262-4':'medium','FN-18':'low/medium','T262-8':'medium','FN-9':'critical/medium','FN-1':'high','PROP-1':'high','PROP-7':'medium','FN-15':'medium/low','T262-7':'high/medium','FN-13':'medium','NOBJ-15':'medium','NOBJ-2':'high'}
G=re.compile(r'((?:'+ID+r'(?:\s*\([^)]*\))?(?:,\s*|\s+and\s+|\s+to\s+))*'+ID+r')\s*\((critical|high|medium|low)\b')
docs={os.path.basename(f):open(f).read() for f in glob.glob('lenses/*.md')}
docs['ARCHITECTURE-REVIEW.md']=open('ARCHITECTURE-REVIEW.md').read()
for n,t in docs.items():
    for i,l in enumerate(t.split('\n'),1):
        for m in G.finditer(l):
            ids=re.findall(ID,m.group(1)); s=m.group(2)
            # skip "X to Y" ranges and downgrade narratives
            if re.search(r'(high|medium|critical|low) to (high|medium|low)',l[m.end()-12:m.end()+25]): continue
            for x in ids:
                e=merge.get(x,led.get(x,{}).get('final'))
                if e and s not in e.split('/'):
                    print(f'{n}:{i} {x} grouped as ({s}) expected {e} :: {l.strip()[:200]}')
