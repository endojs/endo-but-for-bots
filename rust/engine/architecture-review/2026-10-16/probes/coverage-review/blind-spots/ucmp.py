import json, re, sys
def load(f):
    s=open(f).read(); m=re.search(r'Error: (\{.*?\})\s*$', s, re.S | re.M)
    txt=s[s.index('{'):]
    depth=0
    for i,ch in enumerate(txt):
        if ch=='{': depth+=1
        elif ch=='}':
            depth-=1
            if depth==0: txt=txt[:i+1]; break
    return json.loads(txt)
a=load('ih_uprop.txt'); b=load('node_uprop.txt')
def toset(r):
    s=set()
    for i in range(0,len(r),2): s.update(range(r[i], r[i+1]+1))
    return s
assigned_node=toset(b['Assigned'])
assigned_ih=toset(a['Assigned'])
print('newly assigned in IH (not in node):', len(assigned_ih-assigned_node), 'assigned in node not IH:', len(assigned_node-assigned_ih))
for k in a:
    A=toset(a[k]); B=toset(b[k])
    d1=A-B; d2=B-A
    # filter: differences on code points assigned in both versions
    d1o=sorted(c for c in d1 if c in assigned_node); d2o=sorted(c for c in d2 if c in assigned_node)
    if d1 or d2:
        print(f'{k:32} ih-only {len(d1):5} (old-assigned {len(d1o)}) node-only {len(d2):5} (old-assigned {len(d2o)})', [hex(c) for c in d1o[:6]], [hex(c) for c in d2o[:6]])
