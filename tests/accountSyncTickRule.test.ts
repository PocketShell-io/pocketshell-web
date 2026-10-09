// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeSyncPayload, type HostEntry } from '@pocketshell/core';

/**
 * pocketshell#3072 on the web. The web's local host list IS the synced
 * account (`listConfigHosts` answers the hosts store, which the vault unlock
 * fills from the same slot), so every account host overlaps a local one. The
 * old shared tick rule skipped exactly those aliases: the /account page
 * showed "In account · remove on sync" on every host the user had not ticked
 * by hand, and an untouched Sync now deleted them from the account.
 *
 * The web has no selection logic of its own; this drives the real WebSync
 * (the web's `api.sync`) under core's shared sync store and AccountView, with
 * only the network service, the envelope crypto and the auth/hosts stores
 * faked.
 */

const server = vi.hoisted(() => ({
  account: null as { version: number; plaintext: string } | null,
}));

vi.mock('../src/api/sync', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/api/sync')>();
  return {
    ...real,
    makeSyncService: () => ({
      async pull() {
        return server.account === null ? null : { slot: 'main', version: server.account.version, data: server.account.plaintext };
      },
      async push(_slot: string, data: string) {
        const version = (server.account?.version ?? 0) + 1;
        server.account = { version, plaintext: data };
        return { version };
      },
    }),
  };
});

// The envelope is opaque to this test: identity "encryption".
vi.mock('../src/shared/syncCrypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/shared/syncCrypto')>();
  return {
    ...real,
    encryptToEnvelope: async (plaintext: string) => plaintext,
    decryptEnvelope: async (envelope: string) => envelope,
  };
});

const hostsStore = vi.hoisted(() => ({
  unlocked: true,
  hosts: [] as unknown[],
  signOutLocal: () => undefined,
  importHosts: async () => undefined,
}));
vi.mock('../src/stores/hosts', () => ({ useHostsStore: () => hostsStore }));
vi.mock('../src/stores/auth', () => ({
  useAuthStore: () => ({ signedIn: true, email: 'a@b.c', signOut: () => undefined }),
}));

import { WebSync } from '../src/platform/webSync';
import { provideApi } from '@ui/app/ipc';
import type { PocketShellApi } from '@ui/app/api';
import { useConnectionStore } from '@ui/app/stores/connection';
import { useSettingsStore } from '@ui/app/stores/settings';
import { useSyncStore } from '@ui/app/stores/sync';
import AccountView from '@ui/app/views/AccountView.vue';

function host(name: string): HostEntry {
  return {
    name,
    hostname: `${name}.example.net`,
    port: 22,
    user: 'alexey',
    identityFile: null,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: false,
  };
}

const ACCOUNT = [host('hetzner'), host('fixture'), host('nas')];

function accountNames(): string[] {
  return (JSON.parse(server.account!.plaintext) as { hosts: HostEntry[] }).hosts.map((h) => h.name);
}

/** The web's `api` as webApi.ts builds it, for the groups this flow touches. */
function provideWebApi(): void {
  const sync = new WebSync();
  provideApi({
    sync: {
      status: () => sync.status(),
      login: () => sync.login(),
      logout: () => sync.logout(),
      pull: (slot: string, passphrase: string) => sync.pull(slot, passphrase),
      push: (slot: string, plaintext: string, passphrase: string, baseVersion: number) =>
        sync.push(slot, plaintext, passphrase, baseVersion),
      accountHosts: () => sync.accountHostsList(),
      applyHosts: (hosts: HostEntry[]) => sync.applyHosts(hosts),
    },
    // The synced list stands in for ~/.ssh/config on the web.
    ssh: {
      listConfigHosts: async () => hostsStore.hosts,
      onState: () => () => undefined,
    },
    win: { setTitle: () => undefined },
  } as unknown as PocketShellApi);
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  server.account = { version: 4, plaintext: serializeSyncPayload(ACCOUNT) };
  hostsStore.hosts = ACCOUNT;
  hostsStore.unlocked = true;
  provideWebApi();
});

describe('web: an untouched Sync now keeps every account host (#3072)', () => {
  it('keeps every host when only one was ever ticked by hand', async () => {
    useSettingsStore().syncSelectedHosts = ['nas'];
    const sync = useSyncStore();
    await sync.refreshStatus();
    await useConnectionStore().loadHosts();
    sync.passphrase = 'pw';

    await sync.syncNow();

    expect(sync.message?.kind).toBe('ok');
    expect(accountNames()).toEqual(expect.arrayContaining(['hetzner', 'fixture', 'nas']));
  });

  it('removes a host only after an explicit untick', async () => {
    const sync = useSyncStore();
    await sync.refreshStatus();
    await useConnectionStore().loadHosts();
    sync.passphrase = 'pw';

    sync.setSelected('fixture', false);
    await sync.syncNow();

    expect(accountNames()).toEqual(['hetzner', 'nas']);
  });

  it('the /account page shows no "remove on sync" until the user unticks', async () => {
    useSettingsStore().syncSelectedHosts = ['nas'];
    const wrapper = mount(AccountView);
    await flushPromises();

    expect(wrapper.findAll('.account-host-row')).toHaveLength(3);
    expect(wrapper.text()).not.toContain('remove on sync');

    const row = wrapper.findAll('.account-host-row').find((li) => li.find('.host-alias').text() === 'fixture')!;
    await row.get('input[type=checkbox]').setValue(false);
    expect(row.get('.status-chip').text()).toBe('In account · remove on sync');
    wrapper.unmount();
  });
});
