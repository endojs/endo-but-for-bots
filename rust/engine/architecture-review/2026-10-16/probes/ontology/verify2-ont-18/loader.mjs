// Map @endo/<name>[/sub] to the monorepo workspace package (no node_modules installed).
import { pathToFileURL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
const root = '/home/user/endo-but-for-bots/packages/';
export async function resolve(specifier, context, next) {
  const m = /^@endo\/([^/]+)(\/.*)?$/.exec(specifier);
  if (m) {
    const dir = root + m[1];
    if (m[2]) return next(pathToFileURL(dir + m[2]).href, context);
    const pkg = JSON.parse(readFileSync(dir + '/package.json', 'utf8'));
    let main = pkg.main || './index.js';
    const e = pkg.exports && pkg.exports['.'];
    if (typeof e === 'string') main = e; else if (e && (e.default || e.import)) main = e.default || e.import;
    return next(pathToFileURL(dir + '/' + main).href, context);
  }
  return next(specifier, context);
}
