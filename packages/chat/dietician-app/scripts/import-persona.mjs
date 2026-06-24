// import-persona.mjs — run the one-shot import of dan's persona ~/eating-out DB into a portable instance
// store, and PROVE parity. COPY semantics (non-destructive; the persona DB stays as a parity reference).
//
//   node scripts/import-persona.mjs [srcDir] [dietSpecPath] [destRoot] [person]
//   srcDir default      = ~/.local/state/dietician-app/_import-src/eating-out  (rsync'd from the persona)
//   dietSpecPath default= ~/.local/state/dietician-app/_import-src/family-diets/<person>.md
//   destRoot default    = ~/.local/state/dietician-app/instances/<person>
import os from 'node:os';
import path from 'node:path';
import { makeFsFolder } from '../fs-folder.mjs';
import { makeDietStore } from '../store.mjs';
import { importPersonaDb, sourceCounts } from '../import-db.mjs';

const HOME = os.homedir();
const person = process.argv[5] || 'alexa';
const SRC = process.argv[2] || `${HOME}/.local/state/dietician-app/_import-src/eating-out`;
const SPEC = process.argv[3] || `${HOME}/.local/state/dietician-app/_import-src/family-diets/${person}.md`;
const DEST = process.argv[4] || `${HOME}/.local/state/dietician-app/instances/${person}`;

(async () => {
  console.log(`import-persona: ${SRC} → ${DEST} (person=${person})`);
  const store = makeDietStore(makeFsFolder(DEST), { person });
  const src = sourceCounts({ srcDir: SRC, person });
  console.log('  persona source counts:', JSON.stringify(src));
  const stats = await importPersonaDb({ srcDir: SRC, dietSpecPath: SPEC, store, person });
  console.log('  import stats:', JSON.stringify({ ...stats, errors: stats.errors.slice(0, 5) }));
  const got = await store.counts();
  console.log('  instance store counts:', JSON.stringify(got));

  // parity: VIABLE/BORDERLINE/UNKNOWN come ONLY from the eval dir → must match the persona exactly; SKIP grows
  // by the normalized inline a-priori skips (modulo any slug already present in the eval dir).
  const exact = got.VIABLE === src.VIABLE && got.BORDERLINE === src.BORDERLINE && got.UNKNOWN === src.UNKNOWN;
  const skipGrew = got.SKIP >= src.SKIP;
  const ok = exact && skipGrew && stats.places > 0 && stats.specBytes > 0;
  console.log(ok
    ? `\n✓ parity: VIABLE/BORDERLINE/UNKNOWN match the persona DB exactly; ${stats.normalizedSkips} inline a-priori SKIPs normalized into evaluations/. Diet spec imported (${stats.specBytes}B).`
    : '\n✗ parity check failed (see counts above).');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
