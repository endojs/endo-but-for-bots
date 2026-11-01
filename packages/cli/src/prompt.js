import { stdin, stdout } from 'process';
import readline from 'readline';

/**
 * Prompts the user for input. The answer is trimmed and converted to
 * lowercase.
 *
 * @param {string} question - The question to ask the user.
 * @returns {Promise<string>} The user's answer.
 */
export async function prompt(question) {
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
  });

  return new Promise(resolve => {
    rl.question(`${question}\n`, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

/**
 * Makes a prompter that asks several questions over one stdin reader. Lines
 * are buffered as they arrive, so answers piped in ahead of their questions
 * are not lost between prompts. Answers are trimmed and keep their case.
 *
 * @param {NodeJS.WritableStream} [output] - Where questions are written;
 *   defaults to stdout. Commands whose stdout carries a machine-readable
 *   result pass stderr so the questions do not interleave with it.
 */
export const makePrompter = (output = stdout) => {
  const rl = readline.createInterface({ input: stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return harden({
    /**
     * @param {string} question
     * @returns {Promise<string>} The trimmed answer, or `''` at end of input.
     */
    ask: async question => {
      output.write(`${question}\n`);
      const { done, value } = await lines.next();
      return done ? '' : value.trim();
    },
    close: () => rl.close(),
  });
};
harden(makePrompter);
