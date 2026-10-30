// @ts-check
import { Far } from '@endo/far';

/**
 * Directory-aware host fixture. The backing map exposes slash-separated paths
 * to test assertions and failure hooks; list() returns immediate children only.
 * storeValue accepts the daemon's NameOrPath, and refuses missing parents.
 * @param {Map<string, any>} values
 * @param {{beforeStore?: (value:any,name:string)=>any, afterStore?: (value:any,name:string)=>any,
 * beforeRemove?: (name:string)=>any, afterRemove?: (name:string)=>any,
 * extraHas?: (name:string)=>boolean, onLookup?: (name:string)=>any}} [hooks]
 */
export const directoryHost = (values, hooks = {}) => {
  const key = name => (Array.isArray(name) ? name.join('/') : name);
  const methods = (prefix = '') => ({
    list: (...segments) => {
      const scope = segments.length
        ? `${prefix}${segments.join('/')}/`
        : prefix;
      return harden(
        [...values.keys()]
          .filter(
            name =>
              name.startsWith(scope) && !name.slice(scope.length).includes('/'),
          )
          .map(name => name.slice(scope.length)),
      );
    },
    has: (...segments) =>
      values.has(`${prefix}${segments.join('/')}`) ||
      !!hooks.extraHas?.(`${prefix}${segments.join('/')}`),
    lookup: async name => {
      const path = `${prefix}${key(name)}`;
      await hooks.onLookup?.(path);
      if (!values.has(path)) throw Error(`Unknown name: ${path}`);
      return values.get(path);
    },
    createDirectory: name => {
      methods(prefix).makeDirectory(name);
    },
    makeDirectory: name => {
      const path = `${prefix}${key(name)}`;
      if (values.has(path)) throw Error(`Directory replaced: ${path}`);
      const directory = Far('TestDirectory', methods(`${path}/`));
      values.set(path, directory);
      return directory;
    },
    storeValue: async (value, name) => {
      const path = `${prefix}${key(name)}`;
      const parent = path.slice(0, path.lastIndexOf('/'));
      if (path.includes('/') && !values.has(parent))
        throw Error(`Missing parent: ${parent}`);
      await hooks.beforeStore?.(value, path);
      values.set(path, value);
      await hooks.afterStore?.(value, path);
    },
    remove: async (...names) => {
      const path = `${prefix}${names.join('/')}`;
      await hooks.beforeRemove?.(path);
      values.delete(path);
      // Simulate collection after unlink: no longer reachable from this host.
      for (const child of values.keys())
        if (child.startsWith(`${path}/`)) values.delete(child);
      await hooks.afterRemove?.(path);
    },
  });
  for (const path of [...values.keys()]) {
    const parts = path.split('/');
    parts.pop();
    let prefix = '';
    for (const part of parts) {
      const parent = `${prefix}${part}`;
      if (!values.has(parent))
        values.set(parent, Far('TestDirectory', methods(`${parent}/`)));
      prefix = `${parent}/`;
    }
  }
  return methods();
};
harden(directoryHost);
