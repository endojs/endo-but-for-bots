import json,re,glob,os
led={x['id']:x for x in json.load(open('ledger.json'))}
IDRE=r'(?:CMP|INT|RGX|SNI|SNS|T262|BOOT|CORE|FN|MEM|NOBJ|NVAL|PROP)-(?:NEW-)?\d+'
SEV=r'(critical|high|medium|low)'
docs={os.path.basename(f):open(f).read() for f in glob.glob('lenses/*.md')}
docs['ARCHITECTURE-REVIEW.md']=open('ARCHITECTURE-REVIEW.md').read()
out=[]
for name,t in docs.items():
    lines=t.split('\n')
    for i,l in enumerate(lines,1):
        # headings with (severity)
        m=re.match(r'^#{2,4}\s+(.*)$',l)
        if m:
            ids=re.findall(IDRE,m.group(1))
            sv=re.findall(r'\((?:[^()]*?;\s*)?'+SEV+r'(?:[^()]*)\)\s*$',m.group(1))
            sv2=re.findall(SEV,m.group(1).split('—')[-1]) if '—' in m.group(1) else []
            if ids and sv2:
                out.append((name,i,'H',ids[0],ids,sv2[-1] if sv2 else None,l.strip()))
            continue
        if l.startswith('|'):
            cells=[c.strip() for c in l.strip().strip('|').split('|')]
            ids=re.findall(IDRE,cells[0]) if cells else []
            sevs=[c for c in cells[1:] if re.fullmatch(SEV+r'(\s*\(.*\))?',c) or re.fullmatch(r'(critical|high|medium|low)(/(critical|high|medium|low))?',c)]
            if ids and sevs:
                out.append((name,i,'T',ids[0],ids,sevs[0],l.strip()[:160]))
merge_sev={'NOBJ-14':'medium','T262-4':'medium','FN-18':'low/medium','T262-8':'medium'}
sec={'FN-9':'CMP-1','FN-1':'CORE-2','PROP-1':'NOBJ-1','PROP-7':'CORE-4','FN-15':'CORE-12','T262-7':'RGX-1','FN-13':'NOBJ-10','NOBJ-15':'MEM-6'}
bad=0
for name,i,k,first,ids,sv,l in out:
    exp=merge_sev.get(first, led[first]['final'] if first in led else None)
    ok = exp and (sv==exp or (sv in exp.split('/')) )
    if not ok:
        bad+=1
        print(f'{name}:{i} [{k}] {first} has {sv!r}, ledger {led.get(first,{}).get("final")} merge {merge_sev.get(first)} :: {l[:200]}')
print('checked',len(out),'mismatch',bad)
