import re, sys
X='/home/user/endo-but-for-bots/c/moddable/xs/sources/'
R='/home/user/endo-but-for-bots/rust/engine/ironhorse-compile/src/'
h=open(X+'xsScript.h').read()
enum=h.split('XS_NO_TOKEN',1)[1].split('XS_TOKEN_COUNT',1)[0]
ctoks=['XS_NO_TOKEN']+re.findall(r'(XS_TOKEN_\w+)',enum)
print('C tokens',len(ctoks))
syn=open(X+'xsSyntaxical.c').read()
flags_c=syn.split('gxTokenFlags[XS_TOKEN_COUNT]',1)[1].split('};',1)[0]
fl=[l.strip().rstrip(',') for l in re.sub(r'/\*.*?\*/','',flags_c).split('\n') if l.strip() and l.strip()!='= {' and l.strip()!='{']
names_c=syn.split('gxTokenNames[XS_TOKEN_COUNT]',1)[1].split('};',1)[0]
nm=re.findall(r'"((?:[^"\\]|\\.)*)"',names_c)
print('C flags',len(fl),'C names',len(nm))
rs=open(R+'token.rs').read()
renum=re.findall(r'^\s+(\w+) = (\d+),$',rs.split('pub enum Token {',1)[1].split('}',1)[0],re.M)
rnames=re.findall(r'^\s+"((?:[^"\\]|\\.)*)",\s*// (\w+)$',rs.split('XS_TOKEN_NAMES',1)[1].split('];',1)[0],re.M)
tf=open(R+'token_flags.rs').read()
rflags=re.findall(r'/\* (\w+) \*/ (.*?),$',tf.split('static TOKEN_FLAGS',1)[1].split('];',1)[0],re.M)
print('R enum',len(renum),'R names',len(rnames),'R flags',len(rflags))
abbr={'BS':'XS_TOKEN_BEGIN_STATEMENT','BE':'XS_TOKEN_BEGIN_EXPRESSION','AS':'XS_TOKEN_ASSIGN_EXPRESSION','EQ':'XS_TOKEN_EQUAL_EXPRESSION','RE':'XS_TOKEN_RELATIONAL_EXPRESSION','SH':'XS_TOKEN_SHIFT_EXPRESSION','AD':'XS_TOKEN_ADDITIVE_EXPRESSION','ML':'XS_TOKEN_MULTIPLICATIVE_EXPRESSION','EX':'XS_TOKEN_EXPONENTIATION_EXPRESSION','PRE':'XS_TOKEN_PREFIX_EXPRESSION','PO':'XS_TOKEN_POSTFIX_EXPRESSION','ES':'XS_TOKEN_END_STATEMENT','BB':'XS_TOKEN_BEGIN_BINDING','IN':'XS_TOKEN_IDENTIFIER_NAME','UN':'XS_TOKEN_UNARY_EXPRESSION','CA':'XS_TOKEN_CALL_EXPRESSION'}
def camel(c):
    if c=='XS_NO_TOKEN': return 'NoToken'
    return ''.join(p.capitalize() for p in c[len('XS_TOKEN_'):].split('_'))
bad=0
for i,c in enumerate(ctoks):
    if i>=len(renum) or camel(c)!=renum[i][0] or int(renum[i][1])!=i:
        print('ENUM mismatch',i,c,renum[i] if i<len(renum) else None); bad+=1
    if nm[i]!=rnames[i][0].encode().decode('unicode_escape') and nm[i]!=rnames[i][0]:
        print('NAME mismatch',i,c,repr(nm[i]),repr(rnames[i])); bad+=1
    cs=set(x.strip() for x in fl[i].split('|')) - {'0'}
    rset=set(abbr[x.strip()] for x in rflags[i][1].split('|') if x.strip()!='0')
    if cs!=rset or rflags[i][0]!=camel(c):
        print('FLAG mismatch',i,c,cs,rflags[i]); bad+=1
print('mismatches',bad)
