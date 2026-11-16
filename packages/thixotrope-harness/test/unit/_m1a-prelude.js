// @ts-check
// Import this module first in any Node test that imports guest/lib modules:
// it puts the vat prelude (M, makeExo, E, ...) on globalThis before they
// load (ES modules evaluate imports in order). AVA skips files starting with
// an underscore, so this is a helper, not a test.
import { installGuestPrelude } from '../../scripts/guest-prelude.js';

installGuestPrelude();
