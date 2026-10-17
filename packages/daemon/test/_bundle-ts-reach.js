import { E } from '@endo/eventual-send';
import { M } from '@endo/patterns';

export const kinds = harden([typeof E, typeof M.split]);
