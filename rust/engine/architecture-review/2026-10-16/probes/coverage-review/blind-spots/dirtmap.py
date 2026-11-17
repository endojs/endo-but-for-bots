import re, glob, sys
R='/home/user/endo-but-for-bots/rust/engine/'
st=open(R+'ironhorse-vm/src/interp/state.rs').read()
body=st.split('pub struct Interp {',1)[1]
# split into field decls: attributes then "name: Type,"
fields={}
cur=[]
for line in body.split('\n'):
    cur.append(line)
    m=re.match(r"^    (?:pub(?:\([^)]*\))? )?(\w+): (.+?),?\s*$", line)
    if m and not line.strip().startswith('#') and not line.strip().startswith('//'):
        txt='\n'.join(cur)
        masks=set(re.findall(r'SnapshotSection::(\w+)\.mask', txt))
        tracked='Tracked' in m.group(2) or 'Tracked' in txt.split('#[boot_new',1)[-1][:300]
        fields[m.group(1)]=(m.group(2).strip(), masks, tracked)
        cur=[]
print('fields',len(fields), file=sys.stderr)
src=''
for f in glob.glob(R+'ironhorse-vm/src/**/*.rs', recursive=True):
    if '/tests' in f: continue
    src+=open(f).read()+'\n'
secs={'Arrays':'arrays_snapshot','IndexProperties':'index_props_snapshot','Collections':'collections_snapshot','Registry':'symbol_registry_snapshot','Errors':'errors_snapshot','Buffers':'array_buffers_snapshot','TypedArrays':'typed_arrays_snapshot','DataViews':'data_views_snapshot','Wrappers':'wrappers_snapshot','Regexps':'regexps_snapshot','ArgumentsBrands':'arguments_brands_snapshot','Temporal':'temporal_snapshot','Intl':'intl_snapshot','Iterators':'iterators_snapshot','Dates':'dates_snapshot','Functions':'function_state_snapshot','Proxies':'proxy_state_snapshot','Accessors':'accessors_snapshot','IntlBoundFunctions':'intl_bound_functions_snapshot','PrivateElements':'private_elements_snapshot','DisposableStacks':'disposable_stacks_snapshot','Generators':'generators_snapshot','Promises':'promise_cluster_snapshot','WeakRefs':'weak_refs_snapshot','FinalizationRegistries':'finalization_registries_snapshot'}
def fnbody(name):
    m=re.search(r'fn '+name+r'\b[^{]*\{', src)
    if not m: return None
    i=m.end(); d=1
    while d:
        c=src[i]
        if c=='{': d+=1
        elif c=='}': d-=1
        i+=1
    return src[m.end():i]
def collect(name, seen):
    if name in seen: return set()
    seen.add(name)
    b=fnbody(name)
    if b is None: return set()
    refs=set(re.findall(r'self\.(\w+)\b(?!\s*\()', b))
    for callee in set(re.findall(r'self\.(\w+)\(', b)):
        if callee.endswith('_snapshot') or callee.startswith(('snapshot_','persist','encode','image_','stored_')):
            refs |= collect(callee, seen)
    return refs
for sec, fn in secs.items():
    refs=collect(fn, set())
    issues=[]
    for r in sorted(refs):
        if r in fields:
            t,masks,tracked=fields[r]
            if sec not in masks:
                issues.append(f'{r}[{"T" if tracked else "-"}:{",".join(sorted(masks)) or "none"}]')
    print(sec, fn, 'reads', len([r for r in refs if r in fields]), 'fields; not-masked-for-section:', issues)
