// @ts-check
/** @param {string[]} words */
export const joinWords = words => {
  const parts = [];
  for (const word of words) parts.push(word);
  return parts.join(' ');
};
