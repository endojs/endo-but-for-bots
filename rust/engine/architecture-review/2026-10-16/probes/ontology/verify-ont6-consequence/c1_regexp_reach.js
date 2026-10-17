var out={}; function t(n,f){try{out[n]=String(f())}catch(e){out[n]='THROW '+e.name+':'+e.message}}
function get(o, path){ return path.split('.').reduce(function(a,k){ return a==null? a : a[k]; }, o); }
t('lodash_get', function(){ var r=/ab/gi; return get({re:r}, 're.flags')+'|'+get({re:r}, 're.source'); });
t('map_keys', function(){ var r=/ab/gim; return ['source','flags','global','multiline'].map(function(k){return r[k];}).join(','); });
t('super_flags', function(){ class R extends RegExp { get flags(){ return 'x'+super.flags; } } var r=new R('a','gi'); return r.flags; });
t('super_source', function(){ class R extends RegExp { get source(){ return '<'+super.source+'>'; } } var r=new R('a','g'); return r.source + ' ' + String(r); });
t('dot', function(){ var r=/ab/gi; return r.flags+'|'+r.source; });
t('destructure', function(){ var {flags, source, global:g}=/ab/gi; return flags+'|'+source+'|'+g; });
t('lastIndex_paths', function(){ var r=/a/g; r.lastIndex=3; var k='lastIndex'; var d=Object.getOwnPropertyDescriptor(r,'lastIndex'); return [r.lastIndex, r[k], Reflect.get(r,k), k in r, d && d.value, Object.getOwnPropertyNames(r).join('/')].join('|'); });
t('proto_tostring', function(){ return RegExp.prototype.toString(); });
t('feature_detect', function(){ return ['hasIndices' in RegExp.prototype, 'unicodeSets' in RegExp.prototype, typeof Object.getOwnPropertyDescriptor(RegExp.prototype,'flags')].join('|'); });
t('assign_spread', function(){ var r=/a/g; return JSON.stringify(Object.assign({}, r))+JSON.stringify({...r}); });
throw new Error(JSON.stringify(out));
