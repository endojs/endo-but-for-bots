// @ts-check
import { Far } from '@endo/far';
import harden from '@endo/harden';
// By name: a bundled ephemeral module reaches a Node builtin through an
// exit that binds its named exports, not a default import.
import { exit, pid } from 'node:process';

export const make = () =>
  Far('NativeTestResource', {
    pid: () => pid,
    echo: value => value,
    exit: () => exit(0),
  });
harden(make);
