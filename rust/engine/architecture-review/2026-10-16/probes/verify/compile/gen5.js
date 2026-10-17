const fs = require('fs');
const arr = '[' + '0,'.repeat(150000) + '0]';
for (const d of [0, 85]) {
  fs.writeFileSync(`cover_assign_${d}.js`, 'var a = {};\n' + '('.repeat(d) + 'a[' + arr + ']' + ')'.repeat(d) + ' = 1;\n');
}
for (const d of [1, 80]) {
  fs.writeFileSync(`pattern_arrow_${d}.js`, 'var f = (' + '['.repeat(d) + 'a = ' + arr + ']'.repeat(d) + ') => 1;\n');
  fs.writeFileSync(`pattern_assign_${d}.js`, 'var a;\n' + '['.repeat(d) + 'a = ' + arr + ']'.repeat(d) + ' = [];\n');
}
