import re, sys
def opcodes(path):
    text = open(path, encoding='utf-8', errors='replace').read()
    m = re.search(r'XS_NO_CODE\s*=\s*0,(.*?)XS_CODE_COUNT', text, re.S)
    body = re.sub(r'//[^\n]*', '', m.group(1))
    body = re.sub(r'/\*.*?\*/', '', body, flags=re.S)
    names = ['XS_NO_CODE'] + [n.strip() for n in body.split(',') if n.strip()]
    ver = re.search(r'#define XS_MAJOR_VERSION (\d+)', text)
    return names, (ver.group(1) if ver else '?')
paths = sys.argv[1:]
prev = None
for p in paths:
    names, ver = opcodes(p)
    line = f"{p.split('/')[-1]}: count={len(names)} first XS_MAJOR_VERSION={ver}"
    if prev:
        pn, pp = prev
        common = [n for n in pn if n in names]
        renum = [n for n in common if pn.index(n) != names.index(n)]
        added = [n for n in names if n not in pn]
        removed = [n for n in pn if n not in names]
        line += f" | vs {pp.split('/')[-1]}: added={len(added)} removed={len(removed)} renumbered={len(renum)} of {len(common)}"
        line += f"\n    added: {added}\n    removed: {removed}"
        if renum:
            line += f"\n    first renumbered: {renum[0]} {pn.index(renum[0])}->{names.index(renum[0])}"
    print(line)
    prev = (names, p)
