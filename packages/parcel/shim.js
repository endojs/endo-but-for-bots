/* The eager first-wins shim entry.
 *
 * Import this in a lockdown bootstrap BEFORE `lockdown()` to race
 * to install the `Parcel` constructor at `globalThis.Parcel`
 * immediately. SES samples the initial constructor, derives the shared
 * constructor without `locate`, and hardens both at lockdown. A later shim
 * evaluation may adopt a valid constructor already visible in its compartment
 * but cannot install one after lockdown. First-wins makes repeated imports
 * converge on one constructor and private table.
 */

import { provideParcel } from './src/parcel-shim.js';

provideParcel();
