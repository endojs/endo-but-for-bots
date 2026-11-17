import re,glob,os,json,sys
items=json.load(open('probes/coverage-review/lost-content/items.json'))
corpus_files=sorted(glob.glob('lenses/*.md'))+['ARCHITECTURE-REVIEW.md']
if '--syn' in sys.argv: corpus_files+=glob.glob('synthesis/*.md')+glob.glob('lenses/work/ont-parts/*.md')
corpus={f:open(f).read() for f in corpus_files}
alltext='\n'.join(corpus.values())
FILERE=r'([A-Za-z0-9_./-]*?([A-Za-z0-9_-]+\.(?:rs|js|mjs|md|py|sh|toml|yml|yaml|json|c|h|txt)))(?::|`?\s*(?:line|lines)\s*)?(\d+)?(?:\s*[-–]\s*(\d+))?'
def refs(text):
    out=[]
    for m in re.finditer(FILERE,text):
        b=m.group(2); a=m.group(3); e=m.group(4)
        out.append((b,int(a) if a else None,int(e) if e else None))
    return out
idx={}
for f,t in corpus.items():
    for b,a,e in refs(t):
        idx.setdefault(b,[]).append((a,e if e else a))
def file_hit(b,a):
    if b not in idx: return False
    if a is None: return True
    for s,e in idx[b]:
        if s is None: continue
        if s-5<=a<=(e or s)+5: return True
    return False
STOP=set('true false null undefined None Some self this value Error TypeError RangeError SyntaxError'.split())
def codes(text):
    out=[]
    for m in re.finditer(r'`([^`\n]{3,80})`',text):
        c=m.group(1).strip()
        if re.fullmatch(r'[\d.,\s%~x×*+-]+',c): continue
        if c in STOP: continue
        if re.search(r'\.(rs|js|md|py|sh|toml|yml|json|c|h)(:\d+)?',c): continue
        out.append(c)
    return out
IDRE=r'\b((?:CMP|INT|RGX|SNI|SNS|T262|BOOT|CORE|FN|MEM|NOBJ|NVAL|PROP)-(?:NEW-)?\d+)\b'
res=[]
for it in items:
    t=it['text']
    rs=[(b,a) for b,a,e in refs(t)]
    rs=list(dict.fromkeys(rs))
    cs=list(dict.fromkeys(codes(t)))
    fh=[r for r in rs if file_hit(*r)]
    ch=[c for c in cs if c in alltext]
    ids=list(dict.fromkeys(re.findall(IDRE,t)))
    n=len(rs)+len(cs)
    sc=(len(fh)+len(ch))/n if n else None
    it.update(score=sc,nsig=n,ids=ids,fmiss=[r for r in rs if r not in fh],cmiss=[c for c in cs if c not in ch])
    res.append(it)
json.dump(res,open('probes/coverage-review/lost-content/scored.json','w'),indent=1)
import collections
b=collections.Counter()
for it in res:
    k='none' if it['score'] is None else ('hi' if it['score']>=0.6 else ('mid' if it['score']>=0.3 else 'lo'))
    b[(it['sec'][:12],k)]+=1
for k,v in sorted(b.items()): print(k,v)
