// @ts-check

const maskedTokenTypes = new Set([
  'codeText',
  'htmlText',
  'literalAutolink',
  'mathText',
  'resource',
]);

const commonAbbreviations = new Set([
  'co.',
  'corp.',
  'dr.',
  'e.g.',
  'fig.',
  'i.e.',
  'inc.',
  'jr.',
  'ltd.',
  'mr.',
  'mrs.',
  'ms.',
  'no.',
  'prof.',
  'sr.',
  'st.',
  'vs.',
]);

const closingCharacters = new Set([
  '"',
  "'",
  '”',
  '’',
  ')',
  '}',
  ']',
  '*',
  '_',
  '~',
]);

/**
 * Visit every token in a micromark token tree.
 *
 * @param {readonly import('markdownlint').MicromarkToken[]} roots
 * @returns {import('markdownlint').MicromarkToken[]}
 */
const flattenTokens = roots => {
  const tokens = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const token = queue.shift();
    if (!token) {
      continue;
    }
    tokens.push(token);
    queue.push(...token.children);
  }
  return tokens;
};

/**
 * Whether a token is nested in an HTML block.
 *
 * Markdownlint reparses HTML blocks so their children can contain paragraph
 * tokens.
 * Those paragraphs are still HTML rather than Markdown prose.
 *
 * @param {import('markdownlint').MicromarkToken} token
 * @returns {boolean}
 */
const isInHtmlFlow = token => {
  let ancestor = token.parent;
  while (ancestor) {
    if (ancestor.type === 'htmlFlow') {
      return true;
    }
    ancestor = ancestor.parent;
  }
  return false;
};

/**
 * Replace the characters covered by an inline markup token with spaces.
 *
 * @param {Map<number, string[]>} charactersByLine
 * @param {import('markdownlint').MicromarkToken} token
 */
const maskToken = (charactersByLine, token) => {
  for (
    let lineNumber = token.startLine;
    lineNumber <= token.endLine;
    lineNumber += 1
  ) {
    const characters = charactersByLine.get(lineNumber);
    if (!characters) {
      continue;
    }
    const start = lineNumber === token.startLine ? token.startColumn - 1 : 0;
    const end =
      lineNumber === token.endLine ? token.endColumn - 1 : characters.length;
    characters.fill(' ', start, end);
    if (lineNumber === token.startLine && token.type === 'codeText') {
      characters[start] = '`';
    }
    if (lineNumber === token.startLine && token.type === 'literalAutolink') {
      characters[start] = 'A';
    }
  }
};

/**
 * Whether punctuation belongs to an abbreviation or an initial.
 *
 * @param {string} line
 * @param {number} punctuationIndex
 * @param {string} punctuation
 * @returns {boolean}
 */
const isAbbreviation = (line, punctuationIndex, punctuation) => {
  if (punctuation !== '.') {
    return false;
  }
  const prefix = line.slice(0, punctuationIndex + 1);
  const abbreviation = /(?:^|[\s([{])((?:[A-Za-z]\.){2,}|[A-Za-z]+\.)$/.exec(
    prefix,
  )?.[1];
  if (!abbreviation) {
    return false;
  }
  return (
    commonAbbreviations.has(abbreviation.toLowerCase()) ||
    /^(?:[A-Za-z]\.){2,}$/.test(abbreviation) ||
    /^[A-Z]\.$/.test(abbreviation)
  );
};

/**
 * Whether the text following punctuation looks like a sentence start.
 *
 * @param {string} suffix
 * @returns {boolean}
 */
const startsSentence = suffix => {
  const trimmed = suffix.trimStart();
  if (trimmed.startsWith('`') || trimmed.startsWith('[')) {
    return true;
  }
  const withoutOpeners = trimmed.replace(/^[*_~"'“‘([{]+/, '');
  return /^[\p{Lu}\p{Lt}\d]/u.test(withoutOpeners);
};

/** @type {import('markdownlint').Rule} */
const sentencePerLine = {
  names: ['sentence-per-line'],
  description: 'Start each prose sentence on a new physical line',
  tags: ['style'],
  parser: 'micromark',
  function: (params, onError) => {
    const allTokens = flattenTokens(params.parsers.micromark.tokens);
    const paragraphs = allTokens.filter(
      token => token.type === 'paragraph' && !isInHtmlFlow(token),
    );
    const proseLines = new Set();
    const charactersByLine = new Map();

    for (const paragraph of paragraphs) {
      for (
        let lineNumber = paragraph.startLine;
        lineNumber <= paragraph.endLine;
        lineNumber += 1
      ) {
        proseLines.add(lineNumber);
        if (!charactersByLine.has(lineNumber)) {
          charactersByLine.set(
            lineNumber,
            params.lines[lineNumber - 1].split(''),
          );
        }
      }
    }

    for (const token of allTokens) {
      if (maskedTokenTypes.has(token.type) && !isInHtmlFlow(token)) {
        maskToken(charactersByLine, token);
      }
    }

    for (const lineNumber of proseLines) {
      const original = params.lines[lineNumber - 1];
      const line = charactersByLine.get(lineNumber)?.join('') ?? original;
      for (const punctuation of line.matchAll(/[.!?]+/g)) {
        if (punctuation.index === undefined) {
          continue;
        }
        const punctuationIndex = punctuation.index;
        let cursor = punctuationIndex + punctuation[0].length;
        while (closingCharacters.has(line[cursor])) {
          cursor += 1;
        }
        const whitespaceStart = cursor;
        while (line[cursor] === ' ' || line[cursor] === '\t') {
          cursor += 1;
        }
        if (
          cursor === whitespaceStart ||
          !startsSentence(line.slice(cursor)) ||
          isAbbreviation(
            line,
            punctuationIndex + punctuation[0].length - 1,
            punctuation[0].at(-1) ?? '',
          )
        ) {
          continue;
        }
        onError({
          lineNumber,
          detail: 'Move the next sentence to a new line.',
          context: original,
          range: [punctuationIndex + 1, cursor - punctuationIndex],
        });
      }
    }
  },
};

export default sentencePerLine;
