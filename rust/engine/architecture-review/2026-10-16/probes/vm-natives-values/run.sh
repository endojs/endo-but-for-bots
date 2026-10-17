#!/bin/sh
# usage: run.sh probe.js  -> prints ironhorse vs node diff
f=$1
/home/user/endo-but-for-bots/rust/engine/target/release/ironhorse-xst "$f" 2>&1 | sed 's/^Error: //' > "${f%.js}.ih"
/opt/node22/bin/node "$f" 2>&1 | grep -E '^[A-Za-z]*Error' | sed 's/^Error: //' > "${f%.js}.node"
python3 - "${f%.js}.ih" "${f%.js}.node" <<'PY'
import json,sys
def load(p):
    s=open(p).read().strip()
    try: return json.loads(s)
    except Exception: return [s]
a=load(sys.argv[1]); b=load(sys.argv[2])
if len(a)!=len(b): print("LEN", len(a), len(b)); print("IH:", a); print("NODE:", b)
for i,(x,y) in enumerate(zip(a,b)):
    if x!=y: print(i, "IH:", repr(x)[:300], "| NODE:", repr(y)[:300])
print("done", len(a))
PY
