// @ts-check
// Pure projection shared by the sandbox importer and trusted host controller.
import { createHash } from 'node:crypto';

const LIMIT = 16 * 1024 * 1024;
const requireValue = condition => {
  if (!condition) throw Error('Invalid native context projection');
};

/**
 * @param {{cwd: string, payload: string, leafUuid: string, suffix: readonly any[]}} input
 */
export const renderNativeContext = ({
  cwd,
  payload: prefix,
  leafUuid,
  suffix,
}) => {
  requireValue(typeof cwd === 'string' && cwd.startsWith('/'));
  requireValue(
    typeof prefix === 'string' &&
      prefix.endsWith('\n') &&
      new TextEncoder().encode(prefix).byteLength <= LIMIT,
  );
  requireValue(Array.isArray(suffix));
  for (const record of suffix) {
    requireValue(
      record?.kind === 'message' &&
        ['user', 'assistant'].includes(record.role) &&
        typeof record.content === 'string' &&
        Object.keys(record).length === 3,
    );
  }
  const rows = prefix
    .slice(0, -1)
    .split('\n')
    .map(line => JSON.parse(line));
  const session = rows[0]?.sessionId;
  requireValue(
    typeof session === 'string' &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(session),
  );
  requireValue(
    rows.every(
      row => row.sessionId === session && row.cwd === cwd && !row.isSidechain,
    ),
  );
  // Repeated identities do not advance capture's selected chain.
  requireValue([...new Set(rows.map(row => row.uuid))].at(-1) === leafUuid);
  // Append only synthetic dialogue. Keep the captured bytes, signatures and
  // message identities untouched; native tool evidence must never be forged
  // or repaired through this suffix path.
  let payload = prefix;
  let parentUuid = leafUuid;
  requireValue(
    typeof parentUuid === 'string' && rows.some(row => row.uuid === parentUuid),
  );
  const prefixHash = createHash('sha256').update(prefix).digest('hex');
  const ids = new Set(rows.map(row => row.uuid));
  const leaf = rows.findLast(row => row.uuid === parentUuid);
  if (suffix.length) requireValue(typeof leaf?.timestamp === 'string');
  const model = rows.findLast(row => row.type === 'assistant')?.message?.model;
  for (const [index, record] of suffix.entries()) {
    const hash = createHash('sha256')
      .update(JSON.stringify([prefixHash, index, record]))
      .digest('hex');
    const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    requireValue(!ids.has(uuid));
    ids.add(uuid);
    payload += `${JSON.stringify({
      type: record.role,
      sessionId: session,
      cwd,
      version: 'endo-restored',
      isSidechain: false,
      userType: 'external',
      gitBranch: leaf?.gitBranch ?? '',
      // Synthetic projection time is the durable context cut, not a new
      // historical event. Retried restoration remains byte-identical.
      timestamp: leaf?.timestamp,
      parentUuid,
      uuid,
      message:
        record.role === 'user'
          ? { role: 'user', content: record.content }
          : {
              type: 'message',
              role: 'assistant',
              model: model ?? 'unknown',
              content: [{ type: 'text', text: record.content }],
              stop_reason: 'end_turn',
              stop_sequence: null,
            },
    })}\n`;
    parentUuid = uuid;
  }
  requireValue(new TextEncoder().encode(payload).byteLength <= LIMIT);

  return Object.freeze({
    payload,
    sessionId: session,
    leafUuid: parentUuid,
    prefixSha256: createHash('sha256').update(payload).digest('hex'),
  });
};
// This module also runs in plain Node in the OCI image, without SES globals.
if (typeof harden === 'function') harden(renderNativeContext);
