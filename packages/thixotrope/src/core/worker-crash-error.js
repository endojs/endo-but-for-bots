// @ts-check
import harden from '@endo/harden';

/**
 * An incarnation died or stopped answering without saying why: its process
 * was killed by a signal, or missed its request deadline. Retrying the same
 * journal may or may not crash again, so one crash proves nothing and a run
 * of them without progress does.
 *
 * An engine raises this where the evidence points at the incarnation rather
 * than the host, and leaves the doubtful cases out. A process that exits
 * with a status is not a crash: that is how a worker refuses a lease, a heap
 * it cannot open or a disk it cannot write. Nor is a missing binary, a sink
 * that refuses a frame, or an incarnation the host itself terminated. What
 * is left is not proof either: a signal can come from outside, and a host
 * that is slow enough makes any worker miss a deadline. This is the one
 * failure the transport counts toward giving up on a worker, and it gives a
 * worker up only for a run of them, spread over its retries.
 */
export class WorkerCrashError extends Error {}
harden(WorkerCrashError);
