// @ts-check
/**
 * Imported records (`designs/m2-interfaces.md` 2.4 item 5, 7.3; J-9493):
 * part of the turn runner, called by `export.js` through the runner's
 * `importTurns` and `importEnd`.
 *
 * - `importTurns(list)`: append the records in log order (a `TurnStarted`
 *   must be the next turn id; a `TurnSettled` only the last started turn,
 *   once; a `TurnResolved` only after its settle), rebuild the turn infos,
 *   advance the turn counter, then seal as 4.3 allows.
 * - `importEnd()`: a turn exported while it ran has no settle and would
 *   never get one (nothing runs it here), so it is settled `outcome-unknown`,
 *   resolvable as after a restart (R4-32, P-14), and counted in the usage
 *   totals; the archive can seal past it.
 *
 * Guest rules. Sends nothing itself (`seal` may send `ArchivePort.seal`).
 */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { RecordLog } from './records.js' */
/** @import { TurnIndex } from './turn-index.js' */
const { Fail } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @param {object} options
 * @param {RecordLog} options.records
 * @param {TurnIndex} options.index
 * @param {{ unresolvedInfo: (turnId: string) => any, resolve: (turnId: string) => void }} options.archive
 * @param {{ settled: (status: string) => void }} options.usage
 * @param {(at: unknown) => void} options.see the runner's clock reading
 * @param {() => number} options.lastKnownTime
 * @param {() => boolean} options.idle no turn is current
 * @param {() => void} options.seal `archive.maybeSeal` with the held ports
 */
export const makeTurnImport = ({
  records,
  index,
  archive,
  usage,
  see,
  lastKnownTime,
  idle,
  seal,
}) => {
  /** @param {readonly any[]} list */
  const importTurns = list => {
    idle() || Fail`a turn is current`;
    for (const record of list) {
      if (record.kind === 'turn-started') {
        record.turnId === index.nextId() ||
          Fail`imported turn ${record.turnId} is out of order`;
      } else if (record.kind === 'turn-settled') {
        // Only the last started turn, once (J-9493): a settle outside its
        // span would leave a turn running for ever.
        (record.turnId === `t${index.count()}` &&
          index.info(record.turnId)?.state === 'running') ||
          Fail`imported settle of ${record.turnId} is out of place`;
      } else if (record.kind === 'turn-resolved') {
        index.info(record.turnId)?.state !== 'running' ||
          Fail`imported resolution of ${record.turnId} precedes its settle`;
      }
      records.append(record);
      see(record.at);
      const info =
        index.info(record.turnId) ?? archive.unresolvedInfo(record.turnId);
      if (record.kind === 'turn-started') {
        index.claimed();
        index.add({
          turnId: record.turnId,
          input: record.input,
          at: record.at,
          state: 'running',
          round: 0,
        });
      } else if (info === undefined) {
        // A resolution of a turn archived before the import: nothing kept.
      } else if (record.kind === 'turn-settled') {
        info.state = record.status;
        if (record.error !== undefined) info.error = record.error;
      } else if (record.kind === 'turn-resolved') {
        info.resolution = record.note;
        archive.resolve(record.turnId);
      } else if (typeof record.round === 'number') {
        info.round = Math.max(info.round, record.round);
      }
    }
    seal();
  };

  const importEnd = () => {
    for (const info of index.infos()) {
      if (info.state === 'running') {
        importTurns([
          harden({
            kind: 'turn-settled',
            turnId: info.turnId,
            status: 'outcome-unknown',
            at: lastKnownTime(),
          }),
        ]);
        usage.settled('outcome-unknown');
      }
    }
  };

  return harden({ importTurns, importEnd });
};
harden(makeTurnImport);
