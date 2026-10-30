// @ts-check

/**
 * Compose a grant's limits with its provider's limits. The provider selects
 * the daily budget kind and caps every shared field.
 *
 * @param {Record<string, number>} grantLimits
 * @param {Record<string, number>} providerLimits
 */
export const effectiveInferenceLimits = (grantLimits, providerLimits) => {
  const effective = { ...grantLimits };
  for (const [name, value] of Object.entries(providerLimits)) {
    if (effective[name] !== undefined) {
      effective[name] = Math.min(effective[name], value);
    }
  }
  if (Object.hasOwn(providerLimits, 'dailyTokens')) {
    delete effective.dailyDollars;
    effective.dailyTokens = Math.min(
      effective.dailyTokens ?? providerLimits.dailyTokens,
      providerLimits.dailyTokens,
    );
  } else {
    delete effective.dailyTokens;
    effective.dailyDollars = Math.min(
      effective.dailyDollars ?? providerLimits.dailyDollars,
      providerLimits.dailyDollars,
    );
  }
  return harden(effective);
};
harden(effectiveInferenceLimits);

/**
 * Fold immutable reservation and settlement facts into turn values as they
 * were known at a given time.
 *
 * @param {any[]} events
 * @param {number} [asOfMilliseconds]
 */
export const foldInferenceTurnEvents = (
  events,
  asOfMilliseconds = Number.POSITIVE_INFINITY,
) => {
  const turns = {};
  for (const event of events) {
    const occurredAtMilliseconds =
      event.type === 'reserved'
        ? event.admittedAtMs
        : event.type === 'settled'
          ? event.settledAtMs
          : Number.POSITIVE_INFINITY;
    if (
      Number(occurredAtMilliseconds) <= asOfMilliseconds &&
      event.type === 'reserved'
    ) {
      turns[event.turnId] = harden({
        version: event.version,
        turnId: event.turnId,
        ownerId: event.ownerId,
        providerId: event.providerId,
        grantId: event.grantId,
        agentId: event.agentId,
        model: event.model,
        day: event.day,
        admittedAt: event.admittedAt,
        admittedAtMs: event.admittedAtMs,
        state: 'reserved',
        reservedTokens: event.reservedTokens,
        ...(event.reservedCostMicros === undefined
          ? {}
          : { reservedCostMicros: event.reservedCostMicros }),
      });
    } else if (
      Number(occurredAtMilliseconds) <= asOfMilliseconds &&
      event.type === 'settled' &&
      turns[event.turnId] !== undefined
    ) {
      const prior = turns[event.turnId];
      turns[event.turnId] = harden({
        ...prior,
        state: 'settled',
        disposition: event.disposition,
        usage: event.usage,
        chargedTokens: event.chargedTokens,
        ...(event.chargedCostMicros === undefined
          ? {}
          : { chargedCostMicros: event.chargedCostMicros }),
        overrun: event.overrun,
        settledAt: event.settledAt,
        settledAtMs: event.settledAtMs,
      });
    }
  }
  return harden(turns);
};
harden(foldInferenceTurnEvents);

/**
 * Derive the admission windows from the event log without mutating it.
 *
 * @param {any[]} events
 * @param {number} asOfMilliseconds
 */
export const inferenceUsageAt = (events, asOfMilliseconds) => {
  const turns = Object.values(
    foldInferenceTurnEvents(events, asOfMilliseconds),
  );
  const day = new Date(asOfMilliseconds).toISOString().slice(0, 10);
  return harden({
    turns: harden(turns),
    recent: harden(
      turns.filter(
        turn =>
          Number(turn.admittedAtMs) >= asOfMilliseconds - 60_000 &&
          Number(turn.admittedAtMs) <= asOfMilliseconds,
      ),
    ),
    today: harden(turns.filter(turn => turn.day === day)),
    holding: harden(turns.filter(turn => turn.state === 'reserved')),
  });
};
harden(inferenceUsageAt);

/**
 * Compact complete facts outside both admission windows. Live reservations
 * remain until settlement, including across UTC midnight. Compaction is a
 * separate pure retention step, never a side effect of deciding admission.
 *
 * @param {any[]} events
 * @param {number} asOfMilliseconds
 */
export const compactInferenceTurnEvents = (events, asOfMilliseconds) => {
  const day = new Date(asOfMilliseconds).toISOString().slice(0, 10);
  const retainedTurnIds = new Set(
    Object.values(foldInferenceTurnEvents(events, asOfMilliseconds))
      .filter(
        turn =>
          turn.state === 'reserved' ||
          turn.day === day ||
          Number(turn.admittedAtMs) >= asOfMilliseconds - 60_000,
      )
      .map(turn => turn.turnId),
  );
  return harden(events.filter(event => retainedTurnIds.has(event.turnId)));
};
harden(compactInferenceTurnEvents);

/**
 * @param {any} turn
 * @param {Record<string, number>} limits
 */
const budgetUsed = (turn, limits) =>
  Object.hasOwn(limits, 'dailyDollars')
    ? (turn.chargedCostMicros ?? turn.reservedCostMicros ?? 0)
    : (turn.chargedTokens ?? turn.reservedTokens ?? 0);

/**
 * Decide admission from a value snapshot. Recording a refusal or reservation
 * is deliberately left to the registry's mutation layer.
 *
 * @param {object} options
 * @param {{ recent: any[], today: any[], holding: any[] }} options.usage
 * @param {Array<{ name: string, limits: Record<string, number>, field: string, value: string }>} options.scopes
 * @param {number} options.reservedTokens
 * @param {number | undefined} options.reservedCostMicros
 * @returns {string | undefined}
 */
export const inferenceAdmissionRefusal = ({
  usage,
  scopes,
  reservedTokens,
  reservedCostMicros,
}) => {
  for (const scope of scopes) {
    const matches = turn => turn[scope.field] === scope.value;
    if (
      usage.holding.filter(matches).length >=
      Number(scope.limits.concurrentTurns)
    ) {
      return `${scope.name}-concurrency-exhausted`;
    }
    if (
      usage.recent.filter(matches).length >=
      Number(scope.limits.requestsPerMinute)
    ) {
      return `${scope.name}-rate-limited`;
    }
    if (
      Object.hasOwn(scope.limits, 'dailyDollars') &&
      reservedCostMicros === undefined
    ) {
      return 'unpriced-model';
    }
    const used = usage.today
      .filter(matches)
      .reduce((total, turn) => total + budgetUsed(turn, scope.limits), 0);
    const requested = Object.hasOwn(scope.limits, 'dailyDollars')
      ? /** @type {number} */ (reservedCostMicros)
      : reservedTokens;
    const budget = Object.hasOwn(scope.limits, 'dailyDollars')
      ? scope.limits.dailyDollars * 1_000_000
      : scope.limits.dailyTokens;
    if (Number(used) + Number(requested) > Number(budget)) {
      return `${scope.name}-budget-exhausted`;
    }
  }
  return undefined;
};
harden(inferenceAdmissionRefusal);
