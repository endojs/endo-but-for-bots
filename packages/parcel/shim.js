/* Import before `lockdown()` to install the initial Parcel constructor.
 * Later evaluations adopt the visible initial or shared constructor, preserving
 * one brand and private table across eval twins.
 */

import { provideParcel } from './src/parcel-shim.js';

provideParcel();
