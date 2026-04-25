// Like test-sanity.js but with { stackFiltering: 'verbose' }
import { makeSanityTests } from './_sanity.js';

await makeSanityTests('verbose');
