import re, sys
h = open(sys.argv[1]).read()
rs = open(sys.argv[2]).read()
m = re.search(r'enum\s*\{\s*XS_NO_CODE\s*=\s*0,(.*?)XS_CODE_COUNT', h, re.S)
xs = ['XS_NO_CODE'] + re.findall(r'(XS_CODE_\w+)', m.group(1))
ih = re.findall(r'^\s*(XS_\w+)\s*=\s*(\d+),', rs, re.M)
ihn = [n for n, _ in ih]
print("xs names", len(xs), "ironhorse names", len(ihn), "identical", xs == ihn)
print("ironhorse discriminants dense", all(int(v) == i for i, (_, v) in enumerate(ih)))
body = xs[1:]
print("xs enum (after NO_CODE) sorted alphabetically:", body == sorted(body))
unsorted = [(a, b) for a, b in zip(body, body[1:]) if a > b]
print("out-of-order adjacent pairs:", unsorted[:10], len(unsorted))
