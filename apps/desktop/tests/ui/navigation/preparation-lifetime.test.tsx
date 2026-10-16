import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { NavigationSelection, OwnerMutationRequest, PreferencesPatchEntry } from '../../../src/generated/core';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { NavigationWorkspace } from '../../../src/components/navigation/NavigationWorkspace';
import { NavigationStore } from '../../../src/state/navigation/store';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route, secondId } from '../app/transport';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function entries(request: OwnerMutationRequest): PreferencesPatchEntry[] {
  if (request.command.command !== 'preferences_patch') throw new Error('Expected preferences patch');
  return request.command.params.entries;
}
const seenOnly = (request: OwnerMutationRequest) => entries(request).every(entry => entry.kind === 'mark_seen');
const secondRoute = { ...route, session_id: secondId };
const second: NavigationSelection = { kind: 'session', session: secondRoute };
const projects: NavigationSelection = { kind: 'projects' };

class LifetimeTransport extends AppTransport {
  readonly attempts: OwnerMutationRequest[] = [];
  beforePreferences: (() => Promise<void>) | null = null;
  beforeSession: ((sessionId: string) => Promise<void>) | null = null;
  beforePatch: ((request: OwnerMutationRequest) => Promise<void>) | null = null;
  override async invoke<T>(name: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
    const request = args.request;
    if (name === 'preferences_get') await this.beforePreferences?.();
    if (name === 'session_get' && request.session) await this.beforeSession?.(request.session.session_id);
    if ('command' in request && request.command.command === 'preferences_patch') {
      this.attempts.push(structuredClone(request));
      await this.beforePatch?.(request);
      if (request.command.params.expected_preferences_revision !== this.preferences.revision) {
        this.mutations.push(structuredClone(request));
        return { api_version: 1, ok: false, error: { code: 'revision_conflict', message: 'Preferences changed.',
          hint: 'Reload before retrying.', retryable: false, field_errors: [], current_revision: this.preferences.revision } } as T;
      }
    }
    return super.invoke<T>(name, args);
  }
}

const stores: NavigationStore[] = [];
async function setup() {
  const transport = new LifetimeTransport();
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  transport.preferences.sessions = [transport.view(), { ...transport.view(secondId), tab_order: 1 }];
  const store = new NavigationStore(createDesktopService(transport));
  stores.push(store);
  await store.start();
  await store.opened.open(route).refresh();
  await act(async () => {
    render(<NavigationWorkspace store={store} onRemoveTarget={() => {}} adapterChoices={[]}
      renderSession={view => <p>Showing {view.store.getSnapshot().snapshot?.session.id}</p>} />);
  });
  return { store, transport };
}
async function advance(milliseconds = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}
const opening = () => screen.queryAllByRole('status').find(element => /^Opening(?: |…)/.test(element.textContent ?? ''));
function released(store: NavigationStore) {
  expect(store.getSnapshot()).toMatchObject({ writing: false, pendingOperationId: null, pendingNavigation: null });
  expect(opening()).toBeUndefined();
  expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-10-13T10:00:00.000Z'); });
afterEach(() => { cleanup(); stores.splice(0).forEach(store => store.stop()); notices.clear(); vi.useRealTimers(); });

describe('navigation preparation lifetime', () => {
  it('releases an owner whose preferences read fails during patch preparation before any owner attempt', async () => {
    const { store, transport } = await setup(), seen = gate();
    transport.beforePatch = async request => { if (seenOnly(request)) await seen.promise; };
    await advance(1000);
    expect(transport.attempts).toHaveLength(1);
    let reads = 0;
    transport.beforePreferences = async () => { ++reads; throw new Error('Preparation read unavailable'); };
    let saving!: Promise<boolean>;
    await act(async () => { saving = store.saveTheme('dark', 1); });
    expect(store.getSnapshot()).toMatchObject({ writing: true });
    await advance(500);
    expect(await saving).toBe(false);
    expect(reads).toBe(1);
    expect(transport.attempts.filter(request => !seenOnly(request))).toEqual([]);
    released(store);
    expect(store.getSnapshot().error).toMatchObject({ reason: 'transport' });
    expect(`${screen.queryByRole('alert')?.textContent ?? ''} ${notices.getSnapshot().map(notice => notice.text).join(' ')}`)
      .not.toMatch(/isn.t sure|unknown completion|check again/i);
    transport.beforePreferences = null;
    let next!: Promise<boolean>;
    await act(async () => { next = store.saveTheme('light', store.getSnapshot().preferences!.revision); });
    await advance(500);
    expect(await next).toBe(true);
    expect(transport.preferences.global.theme).toBe('light');
    let navigation!: Promise<boolean>;
    await act(async () => { navigation = store.navigate(projects); });
    await advance(500);
    expect(await navigation).toBe(true);
    expect(transport.preferences.global.selected_navigation).toEqual(projects);
    released(store);
    transport.beforePatch = null;
    await act(async () => { seen.release(); });
    await advance();
  });

  it('releases an owner when an item disappears before its hidden-entry preparation replay', async () => {
    const { store, transport } = await setup(), seen = gate();
    transport.beforePatch = async request => { if (seenOnly(request)) await seen.promise; };
    await advance(1000);
    let saving!: Promise<boolean>;
    await act(async () => { saving = store.setHidden({ ...route, item_id: '1' }, true, 1); });
    delete transport.sessions.get(route.session_id)!.items['1'];
    ++transport.sessions.get(route.session_id)!.revision;
    await act(async () => { await store.opened.get(route)!.refresh(true); });
    expect(store.opened.get(route)!.getSnapshot().snapshot?.session.items['1']).toBeUndefined();
    await advance(500);
    expect(await saving).toBe(false);
    expect(transport.attempts.filter(request => !seenOnly(request))).toEqual([]);
    released(store);
    expect(store.getSnapshot().error).toMatchObject({ reason: 'invalid_response' });
    transport.beforePatch = null;
    await act(async () => { seen.release(); });
    await advance();
    await act(async () => { expect(await store.navigate(projects)).toBe(true); });
    released(store);
  });

  it('quietly releases a superseded navigation when its patch preparation read fails', async () => {
    const { store, transport } = await setup(), seen = gate(), preparation = gate();
    transport.beforePatch = async request => { if (seenOnly(request)) await seen.promise; };
    await advance(1000);
    let reads = 0;
    transport.beforePreferences = async () => {
      if (++reads === 2) { await preparation.promise; throw new Error('Obsolete preparation read failed'); }
    };
    let older!: Promise<boolean>, latest!: Promise<boolean>;
    await act(async () => { older = store.navigate(projects); });
    await advance(500);
    expect(reads).toBe(2);
    expect(transport.attempts.filter(request => !seenOnly(request))).toEqual([]);
    await act(async () => { latest = store.navigate(second); });
    expect(await older).toBe(false);
    await act(async () => { preparation.release(); });
    await advance(500);
    expect(await latest).toBe(true);
    expect(transport.preferences.global.selected_navigation).toEqual(second);
    released(store);
    expect(store.getSnapshot().error).toBeNull();
    expect(notices.getSnapshot()).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
    transport.beforePatch = null;
    await act(async () => { seen.release(); });
    await advance();
  });
});
