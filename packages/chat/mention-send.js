// @ts-check

import harden from '@endo/harden';

/**
 * Assemble the `send()` arguments for a channel-mention notification.
 *
 * Structure: "You were mentioned in " [channel] ":\n\n"
 *   [author1] ": msg1\n  " [author2] ": msg2\n\n..."
 * The channel is always the first embedded reference. Each pet name is
 * wrapped as a one-segment path, never split on a delimiter.
 *
 * @param {object} args
 * @param {string} args.channelPetName
 * @param {{ strings: string[], edgeNames: string[], petNames: string[] }} args.recap
 * @param {string} args.instructions
 * @returns {{ strings: string[], edgeNames: string[], petNamePaths: string[][] }}
 */
export const assembleMentionSend = ({
  channelPetName,
  recap,
  instructions,
}) => {
  const edgeName = channelPetName;
  /** @type {string[]} */
  const strings = [`You were mentioned in `];
  /** @type {string[]} */
  const edgeNames = [edgeName];
  /** @type {string[][]} */
  const petNamePaths = [[channelPetName]];

  if (recap.edgeNames.length > 0) {
    // String after the channel ref: separator + recap
    // lead-in. recap.strings is interleaved as:
    //   strings[0] ref[0] strings[1] ref[1] ... strings[n]
    strings.push(`:\n\n${recap.strings[0]}`);
    const usedEdgeNames = new Set([edgeName]);
    for (let ri = 0; ri < recap.edgeNames.length; ri += 1) {
      // Ensure edge name uniqueness across the message
      let recapEdge = recap.edgeNames[ri];
      if (usedEdgeNames.has(recapEdge)) {
        recapEdge = `${recapEdge}-author`;
      }
      usedEdgeNames.add(recapEdge);
      edgeNames.push(recapEdge);
      petNamePaths.push([recap.petNames[ri]]);
      strings.push(recap.strings[ri + 1] || '');
    }
    strings[strings.length - 1] += instructions;
  } else if (recap.strings.length > 0 && recap.strings[0]) {
    // Recap text but no embedded refs
    strings.push(`:\n\n${recap.strings[0]}${instructions}`);
  } else {
    strings.push(instructions);
  }

  return harden({ strings, edgeNames, petNamePaths });
};
harden(assembleMentionSend);
