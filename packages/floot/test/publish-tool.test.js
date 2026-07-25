// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makePublishTool } from '../src/publish-tool.js';

const makeAssetServer = () => {
  const served = [];
  const revoked = [];
  let counter = 0;
  const server = Far('AssetServer', {
    async serve(filesystem) {
      counter += 1;
      const url = `http://host/token-${counter}/`;
      served.push({ filesystem, url });
      const revoke = Far('AssetMount', {
        async revoke() {
          revoked.push(url);
        },
      });
      return harden({ path: `/token-${counter}/`, url, revoke });
    },
  });
  return { server, served, revoked };
};

test('publishWorkspace serves the workspace and returns its capability URL', async t => {
  const asset = makeAssetServer();
  const workspace = Far('Workspace', {});
  const tool = makePublishTool({
    assetServer: asset.server,
    getWorkspace: async () => workspace,
  });

  t.is(tool.schema().function.name, 'publishWorkspace');
  const result = await E(tool).execute({});
  t.regex(result, /http:\/\/host\/token-1\//);
  t.is(asset.served.length, 1);
  t.is(asset.served[0].filesystem, workspace);
});

test('re-publishing revokes the previous mount before serving again', async t => {
  const asset = makeAssetServer();
  const workspace = Far('Workspace', {});
  const tool = makePublishTool({
    assetServer: asset.server,
    getWorkspace: async () => workspace,
  });

  await E(tool).execute({});
  await E(tool).execute({});
  // The first URL was revoked when the second publish happened.
  t.deepEqual(asset.revoked, ['http://host/token-1/']);
  t.is(asset.served.length, 2);
});

test('revoke() releases the served mount on session teardown', async t => {
  const asset = makeAssetServer();
  const tool = makePublishTool({
    assetServer: asset.server,
    getWorkspace: async () => Far('Workspace', {}),
  });
  await E(tool).execute({});
  await tool.revoke();
  t.deepEqual(asset.revoked, ['http://host/token-1/']);
});

test('with no workspace, publishWorkspace explains rather than serving', async t => {
  const asset = makeAssetServer();
  const tool = makePublishTool({
    assetServer: asset.server,
    getWorkspace: async () => undefined,
  });
  const result = await E(tool).execute({});
  t.regex(result, /no project workspace/i);
  t.is(asset.served.length, 0);
});
