// @ts-check
/* global process */

import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const trialScript = url.fileURLToPath(
  new URL('./daemon-trial.js', import.meta.url),
);

/**
 * @param {string} inputPath
 * @param {string} resultPath
 * @param {NodeJS.ProcessEnv} env
 */
const runChild = async (inputPath, resultPath, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [trialScript, inputPath, resultPath],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      const detail = [stdout, stderr].filter(Boolean).join('\n').trim();
      reject(
        Error(
          `daemon trial exited with code ${code}${detail ? `\n${detail}` : ''}`,
        ),
      );
    });
  });

/**
 * Keep Ax and Endo in separate processes. Endo installs SES globals that Ax
 * does not expect; the child process is the real daemon runner.
 *
 * @param {object} input
 */
export const runTrial = async input => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fae-opt-runner-'));
  const inputPath = path.join(workDir, 'input.json');
  const resultPath = path.join(workDir, 'result.json');
  const env = input.model
    ? { ...process.env, LAL_MODEL: input.model }
    : process.env;
  try {
    await fs.writeFile(inputPath, JSON.stringify(input));
    await runChild(inputPath, resultPath, env);
    return JSON.parse(await fs.readFile(resultPath, 'utf8'));
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
};
