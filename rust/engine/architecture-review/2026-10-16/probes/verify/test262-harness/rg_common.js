var s = 'line of text\n'.repeat(10000); // 130k chars
var out = [];
function t(name, f) { try { out.push(name + '=' + f()); } catch (e) { out.push(name + '!' + e.name); } }
t('split', function () { return s.split(/\n/).length; });
t('trimRe', function () { return s.replace(/\s+$/, '').length; });
t('dotStarLine', function () { return /^.*$/m.test(s); });
t('anyAll', function () { return /[\s\S]*/.exec(s)[0].length; });
throw new Error(out.join(' '));
