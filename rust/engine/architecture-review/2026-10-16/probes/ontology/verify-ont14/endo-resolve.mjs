import { readFileSync } from 'node:fs';
const root = '/home/user/endo-but-for-bots/packages/';
export async function resolve(specifier, context, next) {
  const m = /^@endo\/([^/]+)(\/.*)?$/.exec(specifier);
  if (m) {
    const dir = root + m[1];
    const pkg = JSON.parse(readFileSync(dir + '/package.json', 'utf8'));
    const sub = m[2] ? '.' + m[2] : '.';
    let target = null;
    const ex = pkg.exports;
    if (ex) {
      let e = typeof ex === 'string' ? (sub === '.' ? ex : null) : ex[sub];
      while (e && typeof e === 'object') e = e.import || e.default || e.node;
      target = e;
    }
    if (!target) target = sub === '.' ? (pkg.main || './index.js') : sub;
    return next('file://' + dir + '/' + target.replace(/^\.\//, ''), context);
  }
  return next(specifier, context);
}
