// @ts-check
// Lock down with @endo/init unless something (ses-ava in tests) already did:
// a second lockdown throws SES_ALREADY_LOCKED_DOWN.
if (!Object.isFrozen(Object.prototype)) await import('@endo/init');
