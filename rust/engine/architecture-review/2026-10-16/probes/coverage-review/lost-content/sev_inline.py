import json,re,glob,os
led={x['id']:x for x in json.load(open('ledger.json'))}
IDRE=r'((?:CMP|INT|RGX|SNI|SNS|T262|BOOT|CORE|FN|MEM|NOBJ|NVAL|PROP)-(?:NEW-)?\d+)'
merge_sev={'NOBJ-14':'medium','T262-4':'medium','FN-18':'low/medium','T262-8':'medium','FN-9':'critical','FN-1':'high','PROP-1':'high','PROP-7':'medium','FN-15':'medium','T262-7':'high','FN-13':'medium','NOBJ-15':'medium','NOBJ-2':'high'}
docs={os.path.basename(f):open(f).read() for f in glob.glob('lenses/*.md')}
docs['ARCHITECTURE-REVIEW.md']=open('ARCHITECTURE-REVIEW.md').read()
for name,t in docs.items():
    for i,l in enumerate(t.split('\n'),1):
        for m in re.finditer(IDRE+r'(?:\s*\((?:same defect|same root)[^)]*\))?\s*(?:\(|,\s*|:\s*|\s+—\s+)(critical|high|medium|low)\b',l):
            i_d,s=m.group(1),m.group(2)
            exp=merge_sev.get(i_d,led.get(i_d,{}).get('final'))
            if exp and s not in exp.split('/'):
                print(f'{name}:{i} {i_d} says {s}, expected {exp} :: {l.strip()[:220]}')
