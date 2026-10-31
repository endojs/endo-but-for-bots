// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makePodmanHostEnvironment } from '../src/podman-host-environment.js';

test('Podman host environment captures only operator engine placement and configuration', t => {
  const ambient = {
    PATH: '/ambient/bin',
    HOME: '/ambient/home',
    XDG_RUNTIME_DIR: '/run/user/1000',
    XDG_CONFIG_HOME: '/ambient/config',
    XDG_DATA_HOME: '/ambient/data',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    CONTAINERS_CONF: '/operator/containers.conf',
    CONTAINERS_CONF_OVERRIDE: '/operator/override.conf',
    CONTAINERS_STORAGE_CONF: '/operator/storage.conf',
    CONTAINERS_REGISTRIES_CONF: '/operator/registries.conf',
    STORAGE_DRIVER: 'overlay',
    STORAGE_OPTS: 'overlay.mount_program=/usr/bin/fuse-overlayfs',
    TMPDIR: '/operator/downloads',
    OPENAI_API_KEY: 'ambient-secret',
    REGISTRY_AUTH_FILE: '/operator/auth.json',
    HTTP_PROXY: 'http://ambient-proxy',
    https_proxy: 'http://ambient-proxy',
    NO_PROXY: '*',
    CONTAINER_HOST: 'ssh://remote',
    CONTAINER_CONNECTION: 'remote',
    CONTAINER_SSHKEY: '/private/ssh',
    DOCKER_HOST: 'tcp://remote',
    NODE_OPTIONS: '--inspect',
  };
  const overrides = {
    HOME: '/explicit/home',
    XDG_DATA_HOME: '/explicit/data',
    OPENAI_API_KEY: 'explicit-secret',
    HTTPS_PROXY: 'http://explicit-proxy',
    CONTAINER_HOST: 'ssh://explicit-remote',
  };
  const captured = makePodmanHostEnvironment(ambient, overrides);
  t.deepEqual(captured, {
    PATH: '/ambient/bin',
    HOME: '/explicit/home',
    XDG_RUNTIME_DIR: '/run/user/1000',
    XDG_CONFIG_HOME: '/ambient/config',
    XDG_DATA_HOME: '/explicit/data',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    CONTAINERS_CONF: '/operator/containers.conf',
    CONTAINERS_CONF_OVERRIDE: '/operator/override.conf',
    CONTAINERS_STORAGE_CONF: '/operator/storage.conf',
    CONTAINERS_REGISTRIES_CONF: '/operator/registries.conf',
    STORAGE_DRIVER: 'overlay',
    STORAGE_OPTS: 'overlay.mount_program=/usr/bin/fuse-overlayfs',
    TMPDIR: '/operator/downloads',
    REGISTRY_AUTH_FILE: '/operator/auth.json',
  });
  t.is(
    makePodmanHostEnvironment(ambient, {
      REGISTRY_AUTH_FILE: '/explicit/auth.json',
    }).REGISTRY_AUTH_FILE,
    '/explicit/auth.json',
  );
  ambient.PATH = '/later/bin';
  overrides.HOME = '/later/home';
  t.is(captured.PATH, '/ambient/bin');
  t.is(captured.HOME, '/explicit/home');
});

test('empty Podman host environment uses the existing executable search fallback', t => {
  t.deepEqual(makePodmanHostEnvironment({}), { PATH: '/usr/bin:/bin' });
});
