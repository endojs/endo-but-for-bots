// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { make } from '../src/file-access-chooser.js';

const FileI = M.interface('TestFile', {
  getStat: M.callWhen().returns(M.record()),
  open: M.callWhen().optional(M.record()).returns(M.record()),
});

const DirectoryI = M.interface('TestDirectory', {
  lookup: M.callWhen(M.string()).returns(M.or(M.remotable(), M.remotable())),
  list: M.callWhen().returns(M.remotable()),
});

const CursorI = M.interface('TestCursor', {
  toArray: M.callWhen().returns(M.array()),
});

const makeFile = () =>
  makeExo('TestFile', FileI, {
    async getStat() {
      return harden({ size: 0n, mtime: 0n, atime: 0n });
    },
    async open(_opts = {}) {
      return harden({});
    },
  });

const makeCursor = entries =>
  makeExo('TestCursor', CursorI, {
    async toArray() {
      return harden(entries);
    },
  });

const makeDirectory = entries =>
  makeExo('TestDirectory', DirectoryI, {
    async lookup(name) {
      if (!(name in entries)) {
        throw Error(`missing child: ${name}`);
      }
      return entries[name];
    },
    async list() {
      return makeCursor([]);
    },
  });

const buildRootFilesystem = () => {
  const chosenDesktopLog = makeFile();
  const chosenProjectReport = makeFile();
  const chosenDocsDir = makeDirectory({});
  const projects = makeDirectory(
    {
      report: chosenProjectReport,
      docs: chosenDocsDir,
    },
  );
  const home = makeDirectory(
    {
      connolly: makeDirectory(
        {
          Desktop: makeDirectory(
            {
              'magit-debug.log': chosenDesktopLog,
              projects,
            },
          ),
        },
      ),
    },
  );
  const root = makeDirectory({ home });
  return harden({
    chosenDesktopLog,
    chosenProjectReport,
    chosenDocsDir,
    async root() {
      return root;
    },
  });
};

const makeChooser = responses => {
  const queued = [...responses];
  const calls = [];
  const chooser = harden({
    async openFile(parentWindow, title, options = {}) {
      calls.push({ parentWindow, title, options });
      const next = queued.shift();
      if (next === undefined) {
        throw Error('no queued chooser response');
      }
      return next;
    },
    async close() {
      calls.push({ close: true });
    },
  });
  return { chooser, calls };
};

const makePowers = (fileChooser, rootFilesystem) =>
  harden({
    lookup(name) {
      if (name === 'file-chooser') {
        return fileChooser;
      }
      if (name === 'root-filesystem') {
        return rootFilesystem;
      }
      throw Error(`unknown power: ${name}`);
    },
  });

test('file access chooser chooses files and supports multiple', async t => {
  const rootFilesystem = buildRootFilesystem();
  const { chooser, calls } = makeChooser([
    {
      response: 0,
      results: {
        uris: [
          'file:///home/connolly/Desktop/magit-debug.log',
          'file:///home/connolly/Desktop/projects/report',
        ],
      },
    },
  ]);
  const accessChooser = await make(makePowers(chooser, rootFilesystem));

  const files = await E(accessChooser).chooseFiles('', 'Choose files', {
    multiple: true,
  });
  const [file0, file1] = await Promise.all(files);

  t.is(files.length, 2);
  t.is(file0, rootFilesystem.chosenDesktopLog);
  t.is(file1, rootFilesystem.chosenProjectReport);
  t.deepEqual(calls[0], {
    parentWindow: '',
    title: 'Choose files',
    options: { multiple: true },
  });
});

test('file access chooser chooses directories', async t => {
  const rootFilesystem = buildRootFilesystem();
  const { chooser, calls } = makeChooser([
    {
      response: 0,
      results: {
        uris: ['file:///home/connolly/Desktop/projects/docs'],
      },
    },
  ]);
  const accessChooser = await make(makePowers(chooser, rootFilesystem));

  const directories = await E(accessChooser).chooseDirectories('', 'Choose directory');
  const [directory0] = await Promise.all(directories);

  t.is(directories.length, 1);
  t.is(directory0, rootFilesystem.chosenDocsDir);
  t.deepEqual(calls[0], {
    parentWindow: '',
    title: 'Choose directory',
    options: { directory: true },
  });
});

test('file access chooser rejects non-file uris', async t => {
  const rootFilesystem = buildRootFilesystem();
  const { chooser } = makeChooser([
    {
      response: 0,
      results: {
        uris: ['https://example.invalid/nope'],
      },
    },
  ]);
  const accessChooser = await make(makePowers(chooser, rootFilesystem));

  await t.throwsAsync(() => E(accessChooser).chooseFiles('', 'Choose file'), {
    message: /file: URI/,
  });
});
