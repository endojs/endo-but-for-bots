/* global Buffer */
/* eslint no-bitwise: ["off"] */
// Test fixture helpers that shell out to `cryptsetup`, `mke2fs`, and
// `truncate` to produce *real* LUKS2 / ext4 ground truth, plus `node:crypto`
// to lay down the encrypted data area independently of the code under test.
// Every consumer guards on `haveTools()` and skips when the tools are absent,
// so the suite stays green on machines without them.

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

export const haveTools = (...names) => {
  for (const name of names) {
    try {
      execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    } catch {
      return false;
    }
  }
  return true;
};

const plain64Iv = sector => {
  const iv = Buffer.alloc(16);
  let n = BigInt(sector);
  for (let i = 0; i < 16 && n > 0n; i += 1) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
};

/**
 * Format a sparse file as a real LUKS2 volume, recover its master key via
 * cryptsetup, optionally fill its data area with an ext4 filesystem
 * encrypted independently with node:crypto, and return everything a test
 * needs to exercise the reader against ground truth.
 *
 * @param {object} [options]
 * @param {string} [options.passphrase]
 * @param {Record<string, string>} [options.files] path -> UTF-8 contents
 * @param {number} [options.sizeMiB]
 * @param {boolean} [options.withFilesystem]
 */
export const buildLuksVolume = ({
  passphrase = 'test-passphrase-123',
  files = { 'hello.txt': 'hello from luks endo fs\n' },
  sizeMiB = 40,
  withFilesystem = true,
} = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'endo-luks-'));
  const imgPath = join(dir, 'volume.img');
  const passPath = join(dir, 'pass.key');
  const vkPath = join(dir, 'vk.bin');
  writeFileSync(passPath, passphrase); // no trailing newline

  execFileSync('truncate', ['-s', `${sizeMiB}M`, imgPath]);
  execFileSync('cryptsetup', [
    'luksFormat',
    '--type',
    'luks2',
    '--pbkdf',
    'argon2id',
    '--pbkdf-force-iterations',
    '4',
    '--pbkdf-memory',
    '32768',
    '--pbkdf-parallel',
    '1',
    '--batch-mode',
    '--key-file',
    passPath,
    imgPath,
  ]);
  execFileSync('cryptsetup', [
    'luksDump',
    '--dump-volume-key',
    '--volume-key-file',
    vkPath,
    '--key-file',
    passPath,
    imgPath,
  ]);
  const masterKey = new Uint8Array(readFileSync(vkPath));

  const dump = execFileSync('cryptsetup', ['luksDump', imgPath], {
    encoding: 'utf8',
  });
  const offsetMatch = dump.match(/offset:\s*(\d+)\s*\[bytes\]/);
  const sectorMatch = dump.match(/sector:\s*(\d+)\s*\[bytes\]/);
  if (!offsetMatch || !sectorMatch) {
    throw Error(`Could not parse data segment from luksDump:\n${dump}`);
  }
  const dataOffset = Number(offsetMatch[1]);
  const sectorSize = Number(sectorMatch[1]);

  if (withFilesystem) {
    const dataSize = sizeMiB * 1024 * 1024 - dataOffset;
    const srcDir = join(dir, 'src');
    mkdirSync(srcDir);
    for (const [name, contents] of Object.entries(files)) {
      const full = join(srcDir, name);
      const slash = name.lastIndexOf('/');
      if (slash >= 0) {
        mkdirSync(join(srcDir, name.slice(0, slash)), { recursive: true });
      }
      writeFileSync(full, contents);
    }
    const ext4Path = join(dir, 'ext4.img');
    execFileSync('truncate', ['-s', `${dataSize}`, ext4Path]);
    execFileSync('mke2fs', ['-t', 'ext4', '-d', srcDir, '-F', '-q', ext4Path]);

    // Encrypt the ext4 image into the LUKS data area, one sector at a time,
    // with node:crypto's XTS (independent of our codec).
    const imgFd = openSync(imgPath, 'r+');
    const ext4Fd = openSync(ext4Path, 'r');
    const sector = Buffer.alloc(sectorSize);
    const sectorCount = dataSize / sectorSize;
    for (let s = 0; s < sectorCount; s += 1) {
      readSync(ext4Fd, sector, 0, sectorSize, s * sectorSize);
      const cipher = crypto.createCipheriv(
        'aes-256-xts',
        Buffer.from(masterKey),
        plain64Iv(s),
      );
      const ct = Buffer.concat([cipher.update(sector), cipher.final()]);
      writeSync(imgFd, ct, 0, sectorSize, dataOffset + s * sectorSize);
    }
    closeSync(imgFd);
    closeSync(ext4Fd);
  }

  return {
    dir,
    imgPath,
    passphrase,
    masterKey,
    dataOffset,
    sectorSize,
    sizeBytes: sizeMiB * 1024 * 1024,
    files,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};
