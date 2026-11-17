import re,glob,os,json
SECS=['Duplication inventory','Skipped features and refusals inventory','Memory and performance opportunities','Ontology notes','Leads that did not survive']
items=[]
for f in sorted(glob.glob('maps/*.md')):
    m=os.path.basename(f)[:-3]
    t=open(f).read()
    parts=re.split(r'^## ',t,flags=re.M)
    for p in parts:
        title=p.split('\n',1)[0].strip()
        if title not in SECS: continue
        body=p.split('\n',1)[1] if '\n' in p else ''
        lines=body.split('\n')
        cur=None; curline=0
        # line numbers
        start=t.index('## '+title)
        base=t[:start].count('\n')+2
        def flush():
            global cur
            if cur and cur.strip():
                items.append({'map':m,'sec':title,'line':curline,'text':cur.strip()})
            cur=None
        for j,l in enumerate(lines):
            ln=base+j
            if l.startswith('|'):
                flush()
                if re.match(r'^\|\s*-{2,}',l) or re.match(r'^\|[\s:|-]+\|\s*$',l): continue
                # header row detection: next line separator
                if j+1<len(lines) and re.match(r'^\|[\s:|-]+\|\s*$',lines[j+1]): continue
                cur=l; curline=ln; flush()
            elif re.match(r'^(\s{0,1})([-*]|\d+\.)\s',l):
                flush(); cur=l; curline=ln
            elif l.strip()=='' :
                flush()
            elif l.startswith('###'):
                flush()
            else:
                if cur is None: cur=l; curline=ln
                else: cur+='\n'+l
        flush()
json.dump(items,open('probes/coverage-review/lost-content/items.json','w'),indent=1)
from collections import Counter
c=Counter((i['map'],i['sec']) for i in items)
for k,v in sorted(c.items()): print(k,v)
print(len(items))
