import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { createDesktopService } from '../../../src/data/service';
import { NavigationStore } from '../../../src/state/navigation/store';
import { AppTransport } from '../app/transport';

const stores: NavigationStore[] = [];
function store(transport: AppTransport): NavigationStore {
  const value = new NavigationStore(createDesktopService(transport));
  stores.push(value);
  return value;
}
afterEach(() => { stores.splice(0).forEach(value => value.stop()); });

describe('saved text size', () => {
  it.each([70, 80, 90, 100, 110, 120])('saves %i%% with existing preferences and restores it after restarting', async textScale => {
    const transport = new AppTransport();
    transport.preferences.global.theme = 'dark';
    transport.preferences.global.detail_width = 416;
    const before = structuredClone(transport.preferences);
    const first = store(transport);
    await first.start();
    expect(await first.saveTextScale(textScale, before.revision)).toBe(true);
    expect(transport.mutations).toHaveLength(1);
    expect(transport.mutations[0]).toMatchObject({ session: null, command: { command: 'preferences_patch', params: {
      expected_preferences_revision: before.revision,
      entries: [{ kind: 'set_global', preferences: { ...before.global, text_scale: textScale } }],
    } } });
    expect(first.getSnapshot().preferences?.global.text_scale).toBe(textScale);
    expect(transport.preferences.sessions).toEqual(before.sessions);
    first.stop();
    const restarted = store(transport);
    await restarted.start();
    expect(restarted.getSnapshot().preferences?.global).toEqual({ ...before.global, text_scale: textScale });
  });

  it('refuses a stale text size edit instead of overwriting newer UI preferences', async () => {
    const transport = new AppTransport(), navigation = store(transport);
    await navigation.start();
    transport.preferences.revision = 2;
    transport.preferences.global.theme = 'dark';
    await navigation.refresh();
    expect(await navigation.saveTextScale(120, 1)).toBe(false);
    expect(transport.mutations).toEqual([]);
    expect(navigation.getSnapshot().preferences?.global.theme).toBe('dark');
    expect(navigation.getSnapshot().error).toMatchObject({ error: { code: 'revision_conflict' } });
  });

  it('drains a newer size queued while a stale first request refreshes preferences', async () => {
    const transport = new AppTransport(), navigation = store(transport);
    transport.preferences.revision = 2;
    transport.preferences.global.theme = 'dark';
    await navigation.start();
    let release!: () => void, entered!: () => void, blocked = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('request' in args.request && args.request.request.command === 'preferences_get' && !blocked) {
        blocked = true; entered(); await gate;
      }
      return invoke(name, args);
    });
    const stale = navigation.saveTextScale(120, 1);
    await started;
    const latest = navigation.saveTextScale(100, 2);
    release();
    await stale;
    expect(await latest).toBe(true);
    expect(transport.preferences.global).toMatchObject({ theme: 'dark', text_scale: 100 });
    expect(transport.mutations).toHaveLength(1);
    expect(transport.mutations[0].command).toMatchObject({ params: { expected_preferences_revision: 2,
      entries: [{ preferences: { theme: 'dark', text_scale: 100 } }] } });
    expect(navigation.getSnapshot().pendingOperationId).toBeNull();
  });

  it('serializes rapid sizes and writes only the latest queued target against the saved revision', async () => {
    const transport = new AppTransport(), navigation = store(transport);
    await navigation.start();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'preferences_patch'
        && args.request.command.params.entries.some(entry => entry.kind === 'set_global' && entry.preferences.text_scale === 90)) {
        entered(); await gate;
      }
      return invoke(name, args);
    });
    const first = navigation.saveTextScale(90, 1);
    await started;
    const intermediate = navigation.saveTextScale(100, 1), last = navigation.saveTextScale(110, 1);
    release();
    expect(await Promise.all([first, intermediate, last])).toEqual([true, true, true]);
    expect(transport.preferences.global.text_scale).toBe(110);
    expect(transport.mutations.map(request => request.command)).toMatchObject([
      { params: { expected_preferences_revision: 1, entries: [{ preferences: { text_scale: 90 } }] } },
      { params: { expected_preferences_revision: 2, entries: [{ preferences: { text_scale: 110 } }] } },
    ]);
  });

  it.each(['confirmed', 'reconciled'])('retains a queued size while another preference write is %s', async completion => {
    const transport = new AppTransport(), navigation = store(transport);
    await navigation.start();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      if ('command' in args.request && args.request.command.command === 'preferences_patch'
        && args.request.command.params.entries.some(entry => entry.kind === 'set_global' && entry.preferences.theme === 'dark')) {
        entered(); await gate;
      }
      return invoke(name, args);
    });
    const theme = navigation.saveTheme('dark', 1);
    await started;
    const size = navigation.saveTextScale(100, 1);
    if (completion === 'reconciled') transport.failNext = 'preferences_patch';
    release();
    if (completion === 'reconciled') {
      expect(await theme).toBe(false); expect(await size).toBe(false);
      expect(transport.mutations).toHaveLength(1);
      expect(await navigation.retryMutation()).toBe(true);
      // The queued target resumes after the exact uncertain write is reconciled.
      await waitFor(() => expect(transport.preferences.global.text_scale).toBe(100));
    } else {
      expect(await theme).toBe(true); expect(await size).toBe(true);
    }
    expect(transport.preferences.global).toMatchObject({ theme: 'dark', text_scale: 100 });
    const saved = transport.mutations.at(-1)!.command;
    expect(saved).toMatchObject({ params: { expected_preferences_revision: 2, entries: [{ preferences: { theme: 'dark', text_scale: 100 } }] } });
  });
});
