// @ts-check

/**
 * Unit coverage for the generic TypeScript-source renderer behind the
 * code-mode declarations: the constructs a capability's own `.d.ts` may use
 * that a prompt object type has to be printed from.
 *
 * The per-exo divergence gates in `code-mode-types.test.js` check the printed
 * artifacts against their live guards; these check the printer itself against
 * small sources, so a rendering rule can be stated without a whole capability
 * package behind it.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractTsFileTextIR,
  renderDeclaration,
} from '../scripts/code-mode-type-extract.js';

// Extraction resolves relative and `@endo/*` specifiers from the source file's
// own directory, so an in-memory source still needs a real one to sit in.
const IN_MEMORY_SOURCE = fileURLToPath(
  new URL('./code-mode-type-extract-source.ts', import.meta.url),
);

/**
 * @param {string} text
 * @param {{ fileName?: string, rootType?: string }} [options]
 */
const extract = (text, options = {}) => {
  const { fileName = IN_MEMORY_SOURCE, rootType = 'Root' } = options;
  return extractTsFileTextIR({ fileName, text, rootType });
};

/**
 * Write a throwaway package of declaration sources and return a path in it.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {Record<string, string>} files
 * @returns {(name: string) => string}
 */
const writeModules = (t, files) => {
  const directory = mkdtempSync(join(tmpdir(), 'code-mode-type-extract-'));
  t.teardown(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    const fileName = join(directory, name);
    mkdirSync(dirname(fileName), { recursive: true });
    writeFileSync(fileName, text);
  }
  return name => join(directory, name);
};

/**
 * @param {import('../scripts/code-mode-type-extract.js').GlobalTypeIR} ir
 * @param {string} name
 * @returns {string}
 */
const auxText = (ir, name) => {
  const found = ir.auxTypes.find(
    type => type.name === name || type.name.startsWith(`${name}<`),
  );
  if (found === undefined) {
    throw new Error(`no aux type ${name} in ${ir.auxTypes.map(a => a.name)}`);
  }
  return found.text;
};

test('an interface root prints its method signatures as members', t => {
  const ir = extract(`
    export interface Root {
      kind(): 'directory';
      help(method?: string): string;
    }
  `);
  t.deepEqual(ir.members, [
    { name: 'help', signature: '(method?: string) => string' },
    { name: 'kind', signature: "() => 'directory'" },
  ]);
});

test('a property signature root member still prints as its declared type', t => {
  const ir = extract(`
    export interface Root {
      list: (...pathSegments: string[]) => Promise<string[]>;
      options?: { maxResults?: number };
    }
  `);
  t.deepEqual(ir.members, [
    {
      name: 'list',
      signature: '(...pathSegments: string[]) => Promise<string[]>',
    },
    {
      name: 'options?',
      signature: '{\n    maxResults?: number;\n}',
    },
  ]);
});

test('same-named method overloads fold into one callable member', t => {
  const ir = extract(`
    export interface Entry {
      segments(): string[];
    }
    export interface Root {
      has(...pathSegments: string[]): Promise<boolean>;
      has(entry: Entry): Promise<boolean>;
    }
  `);
  t.deepEqual(
    ir.members.map(member => member.name),
    ['has'],
  );
  t.is(
    ir.members[0].signature,
    `{
    (...pathSegments: string[]): Promise<boolean>;
    (entry: Entry): Promise<boolean>;
}`,
  );
  t.is(auxText(ir, 'Entry'), '{\n    segments: () => string[];\n}');
});

test('extends heritage merges base members transitively', t => {
  const ir = extract(`
    export interface Issuer {
      entry(path: string | string[]): string;
    }
    export interface Middle extends Issuer {
      middle(): number;
    }
    export interface Root extends Middle {
      kind(): 'directory';
    }
  `);
  t.deepEqual(
    ir.members.map(member => member.name),
    ['entry', 'kind', 'middle'],
  );
  t.is(
    ir.members[0].signature,
    '(path: string | string[]) => string',
    'an inherited member keeps the signature its base declared',
  );
});

test('a redeclared member shadows the inherited one rather than overloading it', t => {
  const ir = extract(`
    export interface Issuer {
      entry(path: string): string;
    }
    export interface Root extends Issuer {
      entry(path: string[]): number;
    }
  `);
  t.deepEqual(ir.members, [
    { name: 'entry', signature: '(path: string[]) => number' },
  ]);
});

test('an interface reached from a member flattens its own heritage', t => {
  const ir = extract(`
    export interface ChildBase {
      base(): string;
    }
    export interface Child extends ChildBase {
      own(): number;
    }
    export interface Root {
      child(): Child;
    }
  `);
  t.deepEqual(ir.members, [{ name: 'child', signature: '() => Child' }]);
  t.is(
    auxText(ir, 'Child'),
    '{\n    base: () => string;\n    own: () => number;\n}',
  );
});

test('a base no reachable declaration source declares fails loudly', t => {
  t.throws(
    () =>
      extract(`
        import type { Dirent } from 'node:fs';
        export interface Root extends Dirent {
          kind(): 'directory';
        }
      `),
    {
      message: /cannot flatten extends Dirent: no reachable declaration/u,
    },
    'dropping a base would understate the surface the guard enforces',
  );
});

test('a generic base fails rather than printing an unsubstituted parameter', t => {
  t.throws(
    () =>
      extract(`
        export interface Holder<T> {
          value(): T;
        }
        export interface Root extends Holder<string> {
          kind(): 'directory';
        }
      `),
    { message: /type arguments are not substituted/u },
  );
});

test('an adjacent build declaration does not open a package type boundary', t => {
  const pathTo = writeModules(t, {
    'node_modules/@endo/bare-types/package.json': JSON.stringify({
      name: '@endo/bare-types',
      type: 'module',
      exports: { '.': './index.js' },
    }),
    'node_modules/@endo/bare-types/index.js': 'export {};',
    'node_modules/@endo/bare-types/index.d.ts':
      'export interface BuildArtifact { leaked(): string }',
  });
  const ir = extract(
    `
    import type { BuildArtifact } from '@endo/bare-types';
    export interface Root {
      artifact(): BuildArtifact;
    }
  `,
    { fileName: pathTo('root.ts') },
  );
  t.deepEqual(ir.members, [{ name: 'artifact', signature: '() => unknown' }]);
  t.deepEqual(ir.auxTypes, []);
});

test('a type reference outside the @endo namespace still collapses', t => {
  const ir = extract(`
    import type { Dirent } from 'node:fs';
    export interface Root {
      dirent(): Dirent;
    }
  `);
  t.deepEqual(ir.members, [{ name: 'dirent', signature: '() => unknown' }]);
  t.deepEqual(ir.auxTypes, []);
});

test('a name a published index only re-exports resolves through the index', t => {
  const pathTo = writeModules(t, {
    'leaf.ts': `export interface Leaf {
      value(): string;
    }`,
    'starred.ts': `export interface Starred {
      tag(): 'starred';
    }`,
    'index.d.ts': `import type { Leaf } from './leaf.js';
    export type { Leaf };
    export type * from './starred.js';`,
  });
  const ir = extract(
    `export type Root = {
      leaf: import('./index.js').Leaf;
      starred: import('./index.js').Starred;
    };`,
    { fileName: pathTo('root.ts') },
  );
  t.deepEqual(ir.members, [
    { name: 'leaf', signature: 'Leaf' },
    { name: 'starred', signature: 'Starred' },
  ]);
  t.is(auxText(ir, 'Leaf'), '{\n    value: () => string;\n}');
  t.is(auxText(ir, 'Starred'), "{\n    tag: () => 'starred';\n}");
});

test('a root reached through a re-export prints self-references as the root', t => {
  const pathTo = writeModules(t, {
    'leaf.ts': `export interface Leaf {
      self(): Leaf;
      value(): string;
    }`,
    'index.d.ts': `import type { Leaf } from './leaf.js';
    export type { Leaf };`,
  });
  const ir = extract(`export type Root = import('./index.js').Leaf;`, {
    fileName: pathTo('root.ts'),
  });
  t.deepEqual(ir.members, [
    { name: 'self', signature: '() => Root' },
    { name: 'value', signature: '() => string' },
  ]);
  t.deepEqual(
    ir.auxTypes,
    [],
    'the declaration the root resolves to is the root, not a second alias',
  );
});

test('bounded inlining keeps shared and capability aliases named', t => {
  const ir = extract(`
    export type TinyOptions = {
      read?: boolean;
      write?: boolean;
    };
    export type SharedRecord = {
      label: string;
    };
    export interface Child {
      read(record: SharedRecord): string;
      help(): string;
    }
    export interface Root {
      child(): Child;
      create(options?: TinyOptions): Promise<void>;
      inspect(): SharedRecord;
    }
  `);
  const declaration = renderDeclaration(ir, { globalName: 'root' });
  t.true(declaration.aux.includes('type Child ='));
  t.true(declaration.aux.includes('type SharedRecord ='));
  t.false(declaration.aux.includes('type TinyOptions ='));
  t.true(
    declaration.body.includes(`options?: {
        read?: boolean;
        write?: boolean;
    }`),
  );
});
