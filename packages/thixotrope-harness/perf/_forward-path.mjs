// Reconstruct the sequential forwarded-mail interval from native request/response
// pairs. A crank is one native delivery; held OCapN GC frames share its budget.
const only = (items, label) => {
  if (items.length !== 1)
    throw Error(`${label}: expected one, observed ${items.length}`);
  return items[0];
};
const group = vat =>
  vat.startsWith('vat-app-harness-')
    ? 'factory'
    : vat.startsWith('vat-session-')
      ? 'session'
      : 'other';
const app = row => row.methods.filter(method => !method.startsWith('op:gc-'));
const detail = (row, side, method, key) =>
  only(
    row[side].filter(entry => entry.method === method),
    `${method} metadata`,
  )[key];

const identity = vat => vat.replace(/-[^-]+$/, '');

export const forwardPath = (sample, rows) => {
  if (
    sample.recipientRound !== 0 ||
    !sample.senderTurn ||
    !sample.recipientTurn ||
    !Number.isSafeInteger(sample.start) ||
    !Number.isSafeInteger(sample.end) ||
    sample.end < sample.start
  )
    throw Error('Invalid provider endpoints');
  const within = rows.filter(
    r => r.began >= sample.start && r.ended <= sample.end,
  );
  const into = (method, role) =>
    within.filter(r => group(r.vat) === role && app(r).includes(method));
  const sender = only(
    into('roundFinal', 'session').filter(r => r.outbound.includes('post')),
    'sender roundFinal emitting post',
  );
  const recipient = only(
    into('deliverMail', 'session').filter(
      r =>
        r.outbound.includes('startRound') &&
        detail(r, 'outgoingDetails', 'startRound', 'turnId') ===
          sample.recipientTurn,
    ),
    'recipient delivery starting the requested turn',
  );
  const postmark = detail(
    recipient,
    'incomingDetails',
    'deliverMail',
    'postmark',
  );
  if (!Number.isSafeInteger(postmark) || postmark <= 0)
    throw Error('Invalid postmark');
  const factory = only(
    into('post', 'factory').filter(
      r =>
        r.outbound.includes('deliverMail') &&
        detail(r, 'outgoingDetails', 'deliverMail', 'postmark') === postmark,
    ),
    'factory post emitting deliverMail for the recipient delivery',
  );
  const dispatch = only(
    into('dispatching', 'session').filter(
      r =>
        identity(r.vat) === identity(recipient.vat) &&
        r.outbound.includes('fulfill'),
    ),
    'recipient dispatch permission',
  );
  const started = rows
    .filter(
      r =>
        identity(r.vat) === identity(sender.vat) &&
        r.ended <= sample.start &&
        r.outgoingDetails.some(
          entry =>
            entry.method === 'startRound' && entry.turnId === sample.senderTurn,
        ),
    )
    .at(-1);
  if (!started) throw Error('Missing sender turn start');
  const senderSink = detail(
    started,
    'outgoingDetails',
    'startRound',
    'sinkSlot',
  );
  const recipientSink = detail(
    recipient,
    'outgoingDetails',
    'startRound',
    'sinkSlot',
  );
  if (
    !senderSink ||
    !recipientSink ||
    detail(sender, 'incomingDetails', 'roundFinal', 'targetSlot') !==
      senderSink ||
    detail(sender, 'incomingDetails', 'roundFinal', 'round') !== 0 ||
    detail(dispatch, 'incomingDetails', 'dispatching', 'targetSlot') !==
      recipientSink ||
    detail(dispatch, 'incomingDetails', 'dispatching', 'round') !== 0 ||
    !dispatch.outgoingDetails.some(
      entry => entry.method === 'fulfill' && entry.boolean === true,
    )
  )
    throw Error(
      'Turn sink or dispatch permission does not match the provider endpoints',
    );
  const path = [sender, factory, recipient, dispatch];
  const required = ['roundFinal', 'post', 'deliverMail', 'dispatching'];
  const emitted = [
    'publish,post',
    'deliverMail',
    'changed,publish,holdTurn,fulfill,startRound',
    'fulfill',
  ];
  for (const [i, crank] of path.entries()) {
    const methods = app(crank);
    if (
      methods.length !== 1 ||
      methods[0] !== required[i] ||
      crank.outbound.filter(m => !m.startsWith('op:gc-')).join() !== emitted[i]
    )
      throw Error(
        `Unexpected application frame in required ${required[i]} crank`,
      );
  }
  if (
    identity(sender.vat) === identity(recipient.vat) ||
    path.some((r, i) => i && r.began < path[i - 1].ended)
  )
    throw Error('Broken causal order');
  // A new context pull between startRound and the request contributes another
  // receiver delivery. An unknown path fails closed, including another reply.
  const extra = within.filter(
    r =>
      identity(r.vat) === identity(recipient.vat) &&
      r !== dispatch &&
      r !== recipient &&
      r.began >= recipient.ended &&
      app(r).length,
  );
  if (extra.length)
    throw Error(
      `Additional recipient work before request: ${extra
        .map(r => app(r).join('+'))
        .join(', ')}`,
    );
  // Certify this known direct route. Traffic that we cannot place on a
  // documented side branch invalidates a sample rather than being omitted.
  const other = within.filter(r => !path.includes(r));
  other.forEach(crank => {
    const incoming = app(crank).join();
    const outgoing = crank.outbound.filter(m => !m.startsWith('op:gc-')).join();
    if (!incoming && !outgoing) return;
    if (identity(crank.vat) === identity(factory.vat)) {
      if (incoming === 'post' && outgoing === 'deliverMail') {
        const older = detail(
          crank,
          'outgoingDetails',
          'deliverMail',
          'postmark',
        );
        if (
          older < postmark &&
          rows.some(
            row =>
              identity(row.vat) === identity(sender.vat) &&
              row.methods.includes('deliverMail') &&
              row.incomingDetails.some(
                entry =>
                  entry.method === 'deliverMail' && entry.postmark === older,
              ) &&
              row.outbound.filter(m => !m.startsWith('op:gc-')).join() ===
                'fulfill',
          )
        )
          return;
      }
      if (incoming === 'changed' && outgoing === 'publish') return;
      if (incoming === 'fulfill' && ['', 'fulfill'].includes(outgoing)) return;
    }
    // A receipt from an earlier mail can finish in the receiver before this turn.
    if (
      identity(crank.vat) === identity(recipient.vat) &&
      crank.ended <= recipient.began &&
      incoming === 'fulfill' &&
      !outgoing
    )
      return;
    if (identity(crank.vat) === identity(sender.vat)) {
      // The driver's waiter, the post receipt, the sender's next round, or
      // an older mail reply received by the sender.
      if (incoming === 'whenFinished' && !outgoing) return;
      if (incoming === 'fulfill' && !outgoing) return;
      if (
        incoming === 'fulfill' &&
        outgoing === 'publish,startRound' &&
        detail(crank, 'outgoingDetails', 'startRound', 'turnId') ===
          sample.senderTurn &&
        detail(crank, 'outgoingDetails', 'startRound', 'sinkSlot') ===
          senderSink
      )
        return;
      if (
        incoming === 'roundFinal' &&
        outgoing === 'changed,publish,releaseTurn,fulfill' &&
        detail(crank, 'incomingDetails', 'roundFinal', 'round') === 1 &&
        detail(crank, 'incomingDetails', 'roundFinal', 'targetSlot') ===
          senderSink
      )
        return;
      if (
        incoming === 'deliverMail' &&
        outgoing === 'fulfill' &&
        detail(crank, 'incomingDetails', 'deliverMail', 'postmark') < postmark
      )
        return;
    }
    throw Error(
      `Unclassified overlapping delivery: ${incoming} -> ${outgoing}`,
    );
  });
  return { postmark, path, other };
};

export const analyzeForwards = (samples, rows) => {
  if (!samples.length) throw Error('No forwarded mail samples');
  const senderTurns = new Set();
  const recipientTurns = new Set();
  const postmarks = new Set();
  return samples.map(sample => {
    const result = forwardPath(sample, rows);
    if (
      postmarks.has(result.postmark) ||
      senderTurns.has(sample.senderTurn) ||
      recipientTurns.has(sample.recipientTurn)
    )
      throw Error('Duplicate forwarded-mail identity');
    postmarks.add(result.postmark);
    senderTurns.add(sample.senderTurn);
    recipientTurns.add(sample.recipientTurn);
    return result;
  });
};
