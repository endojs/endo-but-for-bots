// @ts-check

export { openLuksDevice } from './src/device.js';
export { parseLuksHeader } from './src/header.js';
export { unlockVolume } from './src/unlock.js';
export { makeXtsCodec } from './src/xts.js';
export { afMerge } from './src/af.js';

/** @import { LuksHeader, LuksMetadata, LuksSegment } from './src/header.js' */
/** @import { LuksVolume } from './src/unlock.js' */
