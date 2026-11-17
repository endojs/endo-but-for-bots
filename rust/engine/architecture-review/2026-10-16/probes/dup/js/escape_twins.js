var out = [];
try { eval('var \\u{100000041} = 1;'); out.push('ident: accepted, A=' + typeof A); } catch (e) { out.push('ident: ' + e.name); }
try { eval('"\\u{100000041}"'); out.push('string: accepted'); } catch (e) { out.push('string: ' + e.name); }
throw new Error(JSON.stringify(out));
