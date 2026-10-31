// README:187-206 says parser depth and regexp nesting refusals are SyntaxErrors.
const out = {};
try { new RegExp('('.repeat(600) + 'a' + ')'.repeat(600)); out.regexpCtor = 'ok'; } catch (e) { out.regexpCtor = e.constructor.name + ': ' + e.message; }
try { eval('/' + '('.repeat(600) + 'a' + ')'.repeat(600) + '/'); out.regexpLit = 'ok'; } catch (e) { out.regexpLit = e.constructor.name + ': ' + e.message; }
try { eval('('.repeat(200) + '1' + ')'.repeat(200)); out.parens = 'ok'; } catch (e) { out.parens = e.constructor.name + ': ' + e.message; }
try { eval('1' + '+1'.repeat(3000)); out.chain = 'ok'; } catch (e) { out.chain = e.constructor.name + ': ' + e.message; }
throw new Error(JSON.stringify(out));
