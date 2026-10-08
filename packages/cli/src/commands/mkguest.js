import os from 'os';
import { E } from '@endo/eventual-send';
import { withEndoAgent } from '../context.js';
import { parsePetNamePath, parseOptionalPetNamePath } from '../pet-name.js';

export const mkguest = async ({
  handleName,
  agentName,
  agentNames,
  introductions,
}) =>
  withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    // A slash-delimited handle or agent name nests the guest inside a
    // directory; the parent directory must already exist (as with
    // `mkdir`, `store`, and `mv`).
    // `--introduce hostName:guestName` endows the guest with the host's
    // `hostName` (a slash-delimited pet name path) as its `guestName`.
    // The flag is keyed by host name, but `endowments` is keyed by guest
    // name, so each pair is inverted here.
    const endowments = Object.fromEntries(
      Object.entries(introductions ?? {}).map(([hostName, guestName]) => [
        guestName,
        parsePetNamePath(hostName),
      ]),
    );
    const newGuest = await E(agent).provideGuest(parsePetNamePath(handleName), {
      endowments,
      agentName: parseOptionalPetNamePath(agentName),
    });
    console.log(newGuest);
  });
