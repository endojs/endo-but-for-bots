// @ts-check
// Runs inside the model sandbox. No transcript-provided path is used for I/O.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const LIMIT = 16 * 1024 * 1024;
const execute = promisify(execFile);
const capture = fileURLToPath(
  new URL('./capture-compaction.mjs', import.meta.url),
);
const requireValue = condition => {
  if (!condition) throw Error('Invalid native context');
};

const main = async () => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    requireValue(bytes <= LIMIT);
    chunks.push(chunk);
  }
  const request = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
  );
  const { checkpoint: input, suffix } = request;
  requireValue(Array.isArray(suffix));
  for (const record of suffix) {
    requireValue(
      record?.kind === 'message' &&
        ['user', 'assistant'].includes(record.role) &&
        typeof record.content === 'string' &&
        Object.keys(record).length === 3,
    );
  }
  requireValue(
    input?.kind === 'native-context' && input.format === 'claude-code-jsonl-v1',
  );
  requireValue(
    typeof input.payload === 'string' && input.payload.endsWith('\n'),
  );
  requireValue(Array.isArray(input.context));
  const rows = input.payload
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line));
  const boundaries = rows.filter(
    row => row.type === 'system' && row.subtype === 'compact_boundary',
  );
  requireValue(boundaries.length <= 1 && rows.length > 0);
  const boundary = boundaries[0];
  const session = rows[0].sessionId;
  requireValue(
    typeof session === 'string' &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(session),
  );
  const config = process.env.CLAUDE_CONFIG_DIR;
  if (typeof config !== 'string' || !path.isAbsolute(config)) {
    throw Error('Missing sandbox configuration directory');
  }
  const project = process.cwd().replaceAll('/', '-');
  for (const row of rows) {
    requireValue(row.sessionId === session && !row.isSidechain);
    requireValue(row.cwd === process.cwd());
    if (row.version === 'endo-restored') {
      // This is the current portable writer's provenance, not an older CLI
      // format. Do not pretend reconstructed dialogue was signed native data.
      requireValue(row.type === 'user' || row.type === 'assistant');
      const content = row.message?.content;
      requireValue(
        typeof content === 'string' ||
          (Array.isArray(content) &&
            content.every(block =>
              ['text', 'tool_use', 'tool_result'].includes(block.type),
            )),
      );
    } else {
      requireValue(row.version === '2.1.233');
    }
    requireValue(
      ['user', 'assistant', 'attachment', 'system'].includes(row.type),
    );
    if (row.type === 'system') requireValue(row === boundary);
  }
  const notice = {
    type: 'endo_capture',
    session_id: session,
  };
  // Reuse the capture validator rather than trusting journal data or maintaining
  // a second ancestry/block parser. Staging is private to this invocation.
  const staging = await mkdtemp(path.join(tmpdir(), 'endo-claude-restore-'));
  try {
    const source = path.join(staging, 'projects', project);
    await mkdir(source, { recursive: true, mode: 0o700 });
    await writeFile(path.join(source, `${session}.jsonl`), input.payload, {
      mode: 0o600,
    });
    const { stdout } = await execute(
      process.execPath,
      [capture, JSON.stringify(notice)],
      {
        cwd: process.cwd(),
        env: { ...process.env, CLAUDE_CONFIG_DIR: staging },
        maxBuffer: LIMIT,
        timeout: 30_000,
      },
    );
    const validated = JSON.parse(stdout);
    requireValue(validated.nativeContext?.transcript === input.payload);
    requireValue(
      JSON.stringify(input.context) ===
        JSON.stringify([
          ...(validated.type === 'endo_compaction'
            ? [{ kind: 'compaction', summary: validated.summary }]
            : []),
          ...validated.retainedTail,
        ]),
    );
    // Append only synthetic dialogue. Keep the captured bytes, signatures and
    // message identities untouched; native tool evidence must never be forged
    // or repaired through this suffix path.
    let payload = input.payload;
    let parentUuid = validated.nativeContext.leafUuid;
    requireValue(
      typeof parentUuid === 'string' &&
        rows.some(row => row.uuid === parentUuid),
    );
    const prefixHash = createHash('sha256').update(input.payload).digest('hex');
    const ids = new Set(rows.map(row => row.uuid));
    const leaf = rows.findLast(row => row.uuid === parentUuid);
    if (suffix.length) requireValue(typeof leaf?.timestamp === 'string');
    const model = rows.findLast(row => row.type === 'assistant')?.message
      ?.model;
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
        cwd: process.cwd(),
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
    requireValue(Buffer.byteLength(payload) <= LIMIT);
    if (suffix.length) {
      await writeFile(path.join(source, `${session}.jsonl`), payload, {
        mode: 0o600,
      });
      const { stdout: extendedOutput } = await execute(
        process.execPath,
        [capture, JSON.stringify(notice)],
        {
          cwd: process.cwd(),
          env: { ...process.env, CLAUDE_CONFIG_DIR: staging },
          maxBuffer: LIMIT,
          timeout: 30_000,
        },
      );
      const extended = JSON.parse(extendedOutput);
      requireValue(extended.nativeContext?.transcript === payload);
      requireValue(
        JSON.stringify(extended.retainedTail) ===
          JSON.stringify([...validated.retainedTail, ...suffix]),
      );
    }
    const destination = path.join(config, 'projects', project);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const temporary = path.join(destination, `.endo-restore-${randomUUID()}`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(payload);
        await file.sync();
      } finally {
        await file.close();
      }
      // Atomic publication replaces a leaf symlink rather than following it.
      // Ancestors resolve only inside this sandbox's existing mounts.
      await rename(temporary, path.join(destination, `${session}.jsonl`));
    } finally {
      await rm(temporary, { force: true });
    }
    process.stdout.write(
      `${JSON.stringify({
        sessionId: session,
        leafUuid: parentUuid,
        prefixSha256: createHash('sha256').update(payload).digest('hex'),
      })}\n`,
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

main().catch(() => {
  process.stderr.write('Claude native context restoration failed\n');
  process.exitCode = 1;
});
