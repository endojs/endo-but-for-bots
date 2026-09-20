// @ts-check
import { Far } from '@endo/far';
import harden from '@endo/harden';
import process from 'node:process';

export const make = () => Far('NativeTestResource', {
  pid: () => process.pid,
  echo: value => value,
  exit: () => process.exit(0),
});
harden(make);
