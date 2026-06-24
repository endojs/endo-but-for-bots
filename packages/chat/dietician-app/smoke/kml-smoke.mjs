// kml-smoke.mjs — build the real safe-eats.kml from dan's imported instance DB and validate it. No network.
//   node smoke/kml-smoke.mjs [instanceRoot]
import os from 'node:os';
import { makeFsFolder } from '../fs-folder.mjs';
import { makeDietStore } from '../store.mjs';
import { makePipeline } from '../core.mjs';

const DEST = process.argv[2] || `${os.homedir()}/.local/state/dietician-app/instances/alexa`;

(async () => {
  const store = makeDietStore(makeFsFolder(DEST), { person: 'alexa' });
  const pipe = makePipeline({ store, person: 'alexa' });
  const r = await pipe.buildMap();
  console.log('buildMap:', JSON.stringify(r));
  const kml = await store.readArtifact('safe-eats.kml');
  const placemarks = (kml.match(/<Placemark>/g) || []).length;
  const green = /<Style id="VIABLE">[\s\S]*?<color>ff00aa00<\/color>/.test(kml);
  const m = kml.match(/<coordinates>(-?\d+\.?\d*),(-?\d+\.?\d*),0<\/coordinates>/);
  const lngLat = m ? `${m[1]},${m[2]}` : '(none)';
  console.log(`  placemarks: ${placemarks} | ABGR green style: ${green} | first coord (lng,lat): ${lngLat} | bytes: ${kml.length}`);
  const ok = r.ok && placemarks === r.total && r.total > 200 && green && !!m;
  console.log(ok
    ? `\n✓ safe-eats.kml built from dan's imported DB — ${r.viable} VIABLE + ${r.borderline} BORDERLINE markers, opens in Google My Maps.`
    : '\n✗ KML build check failed (see above).');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
