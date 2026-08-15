export { markFor as derivePartyMark } from './party-identity.js';
export function composeRegions(
  regions: Array<{
    party?: object;
    Component: import('preact').ComponentType<any>;
    props?: object;
  }>,
  opts?: {
    secret?: string;
    label?: string;
    nameOf?: (party: object) => string | undefined;
  },
): import('preact').VNode;
