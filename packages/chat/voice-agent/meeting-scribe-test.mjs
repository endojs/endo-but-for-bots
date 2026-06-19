// proves the field agent can diarize a room-audio chunk via the meetingScribe cap → backend on tinix.
import '@endo/init';
import fs from 'node:fs';
import { makeMeetingScribe } from './meeting-scribe.mjs';

const wav = process.argv[2] || '/tmp/meeting-test.wav';
const scribe = makeMeetingScribe();
console.log('help:', await scribe.help());
const sid = scribe.start({ hints: { room: 'test' } });
console.log('session:', sid);
const bytes = new Uint8Array(fs.readFileSync(wav));
const { segments } = await scribe.ingest(sid, bytes, 'audio/wav');
console.log(`\ningested ${bytes.length} bytes → ${segments.length} diarized segments:`);
for (const s of segments.slice(0, 6)) console.log(`  [${s.speaker}] ${s.t0}-${s.t1}: ${s.text.slice(0, 50)}`);
const fin = scribe.end(sid);
console.log(`\nspeakers: ${fin.speakers.join(', ')}`);
console.log(segments.length >= 2 && fin.speakers.length >= 2 ? '\n✅ MEETINGSCRIBE CAP OK — diarized transcript via the cap → tinix backend' : '\n⚠ weak result');
process.exit(segments.length >= 2 ? 0 : 1);
