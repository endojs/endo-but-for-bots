import sys, re
def load(path):
    t = open(path).read().strip()
    t = re.sub(r'^.*?START ', 'START ', t)
    s, c = t[len('START '):].split(' CONT ')
    def expand(r):
        out = set()
        for part in r.split(','):
            if not part: continue
            a, b = part.split('-'); out.update(range(int(a), int(b)+1))
        return out
    return expand(s), expand(c.strip())
L = load(sys.argv[1]); R = load(sys.argv[2]); N = load(sys.argv[3])
def h(xs): return [hex(x) for x in sorted(xs)[:6]]
for i, name in enumerate(['ID_Start', 'ID_Continue']):
    lex, ihre, node = L[i], R[i], N[i]
    # lexer start set includes $ and _ (and ZWNJ/ZWJ for continue): compare only >= 0x80
    lex = {x for x in lex if x >= 0x80}; ihre = {x for x in ihre if x >= 0x80}; node = {x for x in node if x >= 0x80}
    print(name, 'lexer-not-ihregexp', len(lex - ihre), h(lex - ihre), 'ihregexp-not-lexer', len(ihre - lex), h(ihre - lex))
    print(name, 'lexer-not-node', len(lex - node), h(lex - node), 'node-not-lexer', len(node - lex), h(node - lex))
    print(name, 'ihregexp-not-node', len(ihre - node), 'node-not-ihregexp', len(node - ihre))
