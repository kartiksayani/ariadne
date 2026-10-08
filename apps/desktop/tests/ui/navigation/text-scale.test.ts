import { afterEach, describe, expect, it } from 'vitest';
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
});
