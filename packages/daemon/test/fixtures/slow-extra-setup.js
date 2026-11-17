// @ts-check

// ENDO_EXTRA setup fixture for daemon-teardown.test.js: a setup that takes a
// while.  The daemon runs ENDO_EXTRA setups after its services are up, so a
// slow one widens the window between "services ready" and "daemon fully
// settled", making any ordering bug in that window deterministic rather than
// a CI timing flake.
export const main = async () => {
  await new Promise(resolve => {
    setTimeout(resolve, 1500);
  });
};
