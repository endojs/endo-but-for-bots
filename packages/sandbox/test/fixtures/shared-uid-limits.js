// @ts-check

import * as nodeFs from 'node:fs';

/**
 * RLIMIT_NPROC counts every task the host uid owns, not just the
 * slice's, so the driver's 512-process default makes bwrap's own
 * namespace clone fail with EAGAIN ("Creating new namespace failed:
 * Resource temporarily unavailable") whenever the test runner's uid is
 * busy, as it is on CI while turbo runs other packages' suites.
 *
 * Live slices whose test is not about the process cap use the test
 * process's own hard limit instead: prlimit sets soft and hard together
 * and an unprivileged process may not raise its hard limit, so anything
 * above it fails with EPERM.  When the hard limit is unlimited (or
 * unreadable, off Linux), fall back to a large finite cap.
 */
const FALLBACK_NPROC = 65_536;

const readHardNproc = () => {
  try {
    const limits = nodeFs.readFileSync('/proc/self/limits', 'utf8');
    const match = limits.match(/^Max processes\s+\S+\s+(\S+)/m);
    const hard = Number(match?.[1]);
    if (Number.isSafeInteger(hard) && hard > 0) {
      return Math.min(hard, FALLBACK_NPROC);
    }
  } catch {
    // Not Linux; bwrap tests skip there anyway.
  }
  return FALLBACK_NPROC;
};

export const SHARED_UID_LIMITS = harden({ nproc: readHardNproc() });
