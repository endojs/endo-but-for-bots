// meeting-scribe.mjs — the meetingScribe capability: a diarizing transcriber the field
// agent can call to turn a room-audio chunk into speaker-labelled segments. The backend
// (self-hosted sherpa-onnx diarization + speaches/whisper on tinix, service `meeting-diarize`
// :8004) is CONFINED inside this object — callers get only start/ingest/end, never the URL
// or host. Swappable backend (self-host today; a cloud streaming diarizer drops in the same
// slot for the per-session cloud opt-in). See RECORD-MEETING-MODE.md §3.
//
// NOTE (the design's known hard problem, §4): the backend diarizes each chunk OFFLINE, so
// speaker labels are consistent WITHIN a chunk but NOT yet stitched ACROSS chunks. Streaming
// label-continuity (diart / cloud streaming / embedding-centroid stitching) is the M1+ follow-up.

const DEFAULT_URL = process.env.MEETING_DIARIZE_URL || 'http://192.168.50.226:8004/diarize';

export const makeMeetingScribe = ({ diarizeUrl = DEFAULT_URL, fetchImpl } = {}) => {
  const doFetch = fetchImpl || globalThis.fetch;
  const sessions = new Map(); // sessionId -> { segments:[], started }
  let seq = 0;
  return harden({
    help: () =>
      'start({hints})->sessionId; ingest(sessionId, audioBytes, mime)->{segments:[{speaker,text,t0,t1}]}; ' +
      'end(sessionId)->{transcript,speakers,segments}. Self-hosted diarization+whisper backend on tinix, swappable.',
    start: (_opts = {}) => {
      const id = `mtg-${(seq += 1)}-${Date.now().toString(36)}`;
      sessions.set(id, { segments: [], started: Date.now() });
      return id;
    },
    ingest: async (sessionId, audioBytes, mime = 'audio/wav') => {
      const s = sessions.get(sessionId);
      if (!s) throw Error(`unknown meeting session ${sessionId}`);
      const fd = new FormData();
      fd.append('file', new Blob([audioBytes], { type: mime }), 'chunk.wav');
      const r = await doFetch(diarizeUrl, { method: 'POST', body: fd });
      if (!r.ok) throw Error(`meetingScribe diarize ${r.status}: ${(await r.text()).slice(0, 140)}`);
      const { segments = [], speakers = [] } = await r.json();
      s.segments.push(...segments);
      return harden({ segments, speakers });
    },
    end: sessionId => {
      const s = sessions.get(sessionId);
      if (!s) throw Error(`unknown meeting session ${sessionId}`);
      sessions.delete(sessionId);
      const speakers = [...new Set(s.segments.map(x => x.speaker))];
      const transcript = s.segments.map(x => `[${x.speaker}] ${x.text}`).join('\n');
      return harden({ transcript, speakers, segments: s.segments });
    },
  });
};
harden(makeMeetingScribe);
