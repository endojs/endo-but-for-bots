/* global Buffer */
/* eslint no-bitwise: ["off"] */
// Build real ext2/3/4 filesystem images with `mke2fs -d` (no mount, no root
// privileges), and real LUKS2 containers with `cryptsetup`, so the reader can
// be tested against ground truth from the reference implementations. The
// encrypted data area is laid down with `node:crypto` XTS, independent of the
// code under test. Consumers guard on `haveTools()` and skip when absent.

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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

/** @param {string} srcDir @param {Record<string, string>} files */
const populate = (srcDir, files) => {
  for (const [name, contents] of Object.entries(files)) {
    const full = join(srcDir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
};

/**
 * @param {object} [options]
 * @param {Record<string, string>} [options.files] path -> UTF-8 contents
 * @param {number} [options.sizeMiB]
 * @param {string[]} [options.features] extra `-O` toggles, e.g.
 *   `['^extent', '^64bit']` to force the classic indirect block map.
 * @param {string} [options.type] 'ext4' (default) or 'ext2'.
 */
export const buildExt4Image = ({
  files = {},
  sizeMiB = 16,
  features = [],
  type = 'ext4',
} = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'endo-ext4-'));
  const imgPath = join(dir, 'fs.img');
  const srcDir = join(dir, 'src');
  mkdirSync(srcDir);
  populate(srcDir, files);
  execFileSync('truncate', ['-s', `${sizeMiB}M`, imgPath]);
  const args = ['-t', type, '-d', srcDir, '-F', '-q'];
  if (features.length > 0) {
    args.push('-O', features.join(','));
  }
  args.push(imgPath);
  execFileSync('mke2fs', args);
  return {
    dir,
    imgPath,
    sizeBytes: statSync(imgPath).size,
    files,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
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
 * cryptsetup, fill its data area with an ext4 filesystem encrypted
 * independently with node:crypto's XTS, and return everything a test needs.
 *
 * @param {object} [options]
 * @param {string} [options.passphrase]
 * @param {Record<string, string>} [options.files]
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
    populate(srcDir, files);
    const ext4Path = join(dir, 'ext4.img');
    execFileSync('truncate', ['-s', `${dataSize}`, ext4Path]);
    execFileSync('mke2fs', ['-t', 'ext4', '-d', srcDir, '-F', '-q', ext4Path]);

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
