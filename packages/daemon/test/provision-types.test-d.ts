import { expectTypeOf } from 'expect-type';

import type { EndoGuest, EndoHost } from '@endo/daemon';
import { assertPetName } from '@endo/daemon/pet-name.js';
import {
  EndoGuestAuthorityShape,
  type EndoGuestAuthority,
} from '@endo/daemon/provision.js';

const credentials = 'credentials';
const github = 'github';
assertPetName(credentials);
assertPetName(github);

const authority: EndoGuestAuthority = {
  mount: {
    workspace: { path: '/repo', deniedSegments: ['.env'] },
    docs: { path: '/repo/docs', readOnly: true },
  },
  git: {
    repo: { mount: 'workspace', path: [] },
    docsHistory: { mount: 'docs', path: [], readOnly: true },
  },
  gitRemote: {
    originCap: {
      git: 'repo',
      name: 'origin',
      url: 'https://example.test/repo.git',
      credential: [credentials, github],
    },
  },
};
expectTypeOf(authority).toEqualTypeOf<EndoGuestAuthority>();
expectTypeOf(EndoGuestAuthorityShape).not.toBeAny();

declare const host: EndoHost;
expectTypeOf(host.provideGuest('session', { authority })).toEqualTypeOf<
  Promise<EndoGuest>
>();
