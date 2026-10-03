// @ts-check

import harden from '@endo/harden';

/**
 * The edge name under which a mention notification embeds its channel.
 * An edge name is a single name and may not contain `/`, so a channel
 * reached by a slash-joined mention token is labeled by its leaf segment.
 *
 * @param {string} channelPetName
 * @returns {string}
 */
export const mentionChannelEdgeName = channelPetName =>
  /** @type {string} */ (channelPetName.split('/').at(-1));
harden(mentionChannelEdgeName);

/**
 * Assemble the `send()` arguments for a channel-mention notification.
 *
 * Structure: "You were mentioned in " [channel] ":\n\n"
 *   [author1] ": msg1\n  " [author2] ": msg2\n\n..."
 * The channel is always the first embedded reference. The channel and each
 * pet name are `/`-joined mention tokens, split into a pet-name path here
 * at the UI boundary.
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
  const edgeName = mentionChannelEdgeName(channelPetName);
  /** @type {string[]} */
  const strings = [`You were mentioned in `];
  /** @type {string[]} */
  const edgeNames = [edgeName];
  /** @type {string[][]} */
  const petNamePaths = [channelPetName.split('/')];

  if (recap.edgeNames.length > 0) {
    // String after the channel ref: separator + recap
    // lead-in. recap.strings is interleaved as:
    //   strings[0] ref[0] strings[1] ref[1] ... strings[n]
    strings.push(`:\n\n${recap.strings[0]}`);
    const usedEdgeNames = new Set([edgeName]);
    for (
      let recapIndex = 0;
      recapIndex < recap.edgeNames.length;
      recapIndex += 1
    ) {
      // Ensure edge name uniqueness across the message
      const baseEdge = recap.edgeNames[recapIndex];
      let recapEdge = baseEdge;
      if (usedEdgeNames.has(recapEdge)) {
        recapEdge = `${baseEdge}-author`;
        for (let n = 2; usedEdgeNames.has(recapEdge); n += 1) {
          recapEdge = `${baseEdge}-author-${n}`;
        }
      }
      usedEdgeNames.add(recapEdge);
      edgeNames.push(recapEdge);
      petNamePaths.push(recap.petNames[recapIndex].split('/'));
      strings.push(recap.strings[recapIndex + 1] || '');
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
