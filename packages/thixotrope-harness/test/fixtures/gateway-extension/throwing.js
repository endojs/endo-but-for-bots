// @ts-check
// A gateway extension file that throws while loading (M3 W3.2;
// designs/m3-interfaces.md 6.1, acceptance 16): the loader logs and skips
// it, and the gateway still serves.
throw Error('fixture extension failed to load');
