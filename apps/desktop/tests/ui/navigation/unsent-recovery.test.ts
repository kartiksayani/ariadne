import { afterEach, expect, it, vi } from 'vitest';
import { createDesktopService, ServiceFailure } from '../../../src/data/service';
import type { DesktopTransport } from '../../../src/data/service';
import { NavigationStore } from '../../../src/state/navigation/store';
import { AppTransport } from '../app/transport';

const first = '00000000-0000-4000-8000-000000009001';
const second = '00000000-0000-4000-8000-000000009002';
const stores: NavigationStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.stop()); vi.restoreAllMocks(); });
const navigation = (transport: AppTransport) => {
  const store = new NavigationStore(createDesktopService(transport));
  stores.push(store);
  return store;
};

it('persists recovery IDs additively without changing tabs, Later or drafts, and reloads them', async () => {
  const transport = new AppTransport(), store = navigation(transport);
  await store.start();
  const before = structuredClone(transport.preferences);
  expect(await store.resolveUnsentInput(first)).toBe(true);
  expect(await store.resolveUnsentInput(second)).toBe(true);
  expect(store.getSnapshot().preferences?.resolved_unsent_input_ids).toEqual([first, second]);
  expect(transport.preferences.sessions).toEqual(before.sessions);
  expect(transport.preferences.later).toEqual(before.later);
  expect(transport.preferences.drafts).toEqual(before.drafts);
  const writes = transport.mutations.length;
  expect(await store.resolveUnsentInput(first)).toBe(true);
  expect(transport.mutations).toHaveLength(writes);
  store.stop();
  const reopened = navigation(transport); await reopened.start();
  expect(reopened.getSnapshot().preferences?.resolved_unsent_input_ids).toEqual([first, second]);
});

it('rebases recovery completion after a foreign preference change without replacing its IDs', async () => {
  const transport = new AppTransport(), store = navigation(transport);
  await store.start();
  const invoke = transport.invoke.bind(transport);
  let conflicted = false;
  vi.spyOn(transport, 'invoke').mockImplementation((async (name, args) => {
    if (name === 'preferences_patch' && !conflicted) {
      conflicted = true;
      ++transport.preferences.revision;
      transport.preferences.global.theme = 'dark';
      transport.preferences.resolved_unsent_input_ids = [second];
      return { api_version: 1, ok: false, error: { code: 'revision_conflict', message: 'Changed preferences.',
        hint: 'Reload.', retryable: false, field_errors: [], current_revision: transport.preferences.revision } };
    }
    return invoke(name, args);
  }) as DesktopTransport['invoke']);
  expect(await store.resolveUnsentInput(first)).toBe(true);
  expect(store.getSnapshot().preferences?.resolved_unsent_input_ids).toEqual([second, first]);
  expect(store.getSnapshot().preferences?.global.theme).toBe('dark');
  expect(transport.mutations.at(-1)?.command).toMatchObject({ command: 'preferences_patch', params: {
    expected_preferences_revision: 2, entries: [{ kind: 'resolve_unsent_input', input_id: first }],
  } });
});

it('confirms recovery at capacity by evicting the oldest ID and preserves that order on reload', async () => {
  const transport = new AppTransport();
  const full = Array.from({ length: 10_000 }, (_, index) => `00000000-0000-4000-8000-${(index + 10_000).toString(16).padStart(12, '0')}`);
  transport.preferences.resolved_unsent_input_ids = full;
  const store = navigation(transport); await store.start();
  expect(await store.resolveUnsentInput(full[0])).toBe(true);
  expect(store.getSnapshot().preferences?.resolved_unsent_input_ids).toEqual(full);
  expect(await store.resolveUnsentInput(first)).toBe(true);
  const expected = [...full.slice(1), first];
  expect(store.getSnapshot().preferences?.resolved_unsent_input_ids).toEqual(expected);
  expect(transport.preferences.resolved_unsent_input_ids).toEqual(expected);
  store.stop();
  const reopened = navigation(transport); await reopened.start();
  expect(reopened.getSnapshot().preferences?.resolved_unsent_input_ids).toEqual(expected);
});

it('throws the recovery retry’s own failure after rebasing a revision conflict', async () => {
  const transport = new AppTransport(), store = navigation(transport);
  await store.start();
  const invoke = transport.invoke.bind(transport);
  let attempts = 0;
  vi.spyOn(transport, 'invoke').mockImplementation((async (name, args) => {
    if (name === 'preferences_patch') {
      const code = ++attempts === 1 ? 'revision_conflict' : 'permission_denied';
      if (attempts === 1) ++transport.preferences.revision;
      return { api_version: 1, ok: false, error: { code, message: 'Marker save failed.', hint: 'Retry.', retryable: false, field_errors: [] } };
    }
    return invoke(name, args);
  }) as DesktopTransport['invoke']);
  await expect(store.resolveUnsentInput(first)).rejects.toMatchObject({ error: { code: 'permission_denied' } });
  expect(attempts).toBe(2);
  expect(store.getSnapshot().preferences?.resolved_unsent_input_ids).toBeUndefined();
});

it('keeps unconfirmed recovery completion pending and retries the same operation', async () => {
  const transport = new AppTransport(), store = navigation(transport);
  await store.start();
  transport.failNext = 'preferences_patch';
  await expect(store.resolveUnsentInput(first)).rejects.toBeInstanceOf(ServiceFailure);
  expect(store.getSnapshot().preferences?.resolved_unsent_input_ids).toBeUndefined();
  expect(await store.resolveUnsentInput(second)).toBe(false);
  const request = transport.mutations.at(-1);
  expect(await store.retryMutation()).toBe(true);
  expect(transport.mutations.at(-1)).toEqual(request);
  expect(store.getSnapshot().preferences?.resolved_unsent_input_ids).toEqual([first]);
});

it('confirms recovery completion without waiting for an unrelated follow-up catalogue read', async () => {
  const transport = new AppTransport(), store = navigation(transport);
  await store.start();
  const reads = transport.queries.length;
  transport.failNext = 'preferences_get';
  expect(await store.resolveUnsentInput(first)).toBe(true);
  expect(transport.queries).toHaveLength(reads);
  expect(store.getSnapshot().preferences?.resolved_unsent_input_ids).toEqual([first]);
});

it('does not mark recovery completed before preference startup or after navigation stops', async () => {
  const transport = new AppTransport(), store = navigation(transport);
  expect(await store.resolveUnsentInput(first)).toBe(false);
  await store.start(); store.stop();
  expect(await store.resolveUnsentInput(first)).toBe(false);
  expect(transport.mutations).toHaveLength(0);
});
