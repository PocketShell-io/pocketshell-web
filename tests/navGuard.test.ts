import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

// Node-env discipline copied from hostsStore.test.ts: `window` is planted,
// not assumed, and this fake records the page's listeners so a test can fire
// a beforeunload through the same door armNavGuard registered under.
const fakeWindow = vi.hoisted(() => {
  const unload = [] as ((event: unknown) => void)[];
  const win = {
    unload,
    addEventListener: (type: string, cb: (event: unknown) => void) => {
      if (type === 'beforeunload') unload.push(cb);
    },
    removeEventListener: () => undefined,
  };
  (globalThis as Record<string, unknown>)['window'] = win;
  return win;
});

// The connection store's setup subscribes api.ssh.onState — the preload's
// job in the app. Nothing in these tests dials, so ssh needs no other member.
vi.mock('@ui/app/ipc', () => ({
  api: { ssh: { onState: () => undefined } },
}));

import { armNavGuard, shouldConfirmLeave } from '../src/platform/navGuard';
import { useConnectionStore } from '@ui/app/stores/connection';
import type { ConnectionState } from '@pocketshell/core';

/** Fire the page's beforeunload listeners with a stand-in event. */
function fireUnload(): { preventDefault: ReturnType<typeof vi.fn>; returnValue: string } {
  const event = { preventDefault: vi.fn(), returnValue: '' };
  for (const handler of fakeWindow.unload) handler(event);
  return event as { preventDefault: ReturnType<typeof vi.fn>; returnValue: string };
}

beforeEach(() => {
  fakeWindow.unload.length = 0;
  setActivePinia(createPinia());
});

describe('shouldConfirmLeave', () => {
  it('every state that holds a workspace asks; only the host picker does not', () => {
    const states: ConnectionState[] = ['connecting', 'connected', 'reconnecting', 'lost'];
    for (const state of states) expect(shouldConfirmLeave(state)).toBe(true);
    expect(shouldConfirmLeave('idle')).toBe(false);
  });
});

describe('armNavGuard', () => {
  it('idle: the close sails through untouched', () => {
    armNavGuard(usePinia());
    const event = fireUnload();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.returnValue).toBe('');
  });

  it('connected: the handler votes to stay — preventDefault plus the Chrome returnValue', () => {
    armNavGuard(usePinia());
    useConnectionStore().state = 'connected';
    const event = fireUnload();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.returnValue).toBe('');
  });

  it('lost with the workspace still open still asks — scrollback dies with the tab', () => {
    armNavGuard(usePinia());
    useConnectionStore().state = 'lost';
    expect(fireUnload().preventDefault).toHaveBeenCalled();
  });

  it('the guard reads the store at UNLOAD time: a disconnect after arming disarms', () => {
    armNavGuard(usePinia());
    const connection = useConnectionStore();
    connection.state = 'connected';
    expect(fireUnload().preventDefault).toHaveBeenCalled();
    connection.state = 'idle';
    const after = fireUnload();
    expect(after.preventDefault).not.toHaveBeenCalled();
    expect(after.returnValue).toBe('');
  });
});

function usePinia(): ReturnType<typeof createPinia> {
  return setActivePinia(createPinia());
}
