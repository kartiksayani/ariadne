import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerMutationRequest, PreferencesPatchEntry, PreferencesSnapshot } from '../../../src/generated/core';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { NavigationStore } from '../../../src/state/navigation/store';
import { sessionSeen } from '../../../src/state/preferences/seen';
import { AppTransport, route } from '../app/transport';

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

class ProvenanceTransport extends AppTransport {
  readonly attempts: OwnerMutationRequest[] = [];
  readonly secondSeen = gate();
  seenAttempts = 0;
  staleRead: PreferencesSnapshot | null = null;
  foreignDraftConflicts = 0;
  draftAttempts = 0;
  override async invoke<T>(name: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
    const request = args.request;
    if (name === 'preferences_get' && this.staleRead) {
      const preferences = this.staleRead;
      this.staleRead = null;
      return { api_version: 1, ok: true, data: { kind: 'preferences_get', data: structuredClone(preferences) } } as T;
    }
    if ('command' in request && request.command.command === 'preferences_patch') {
      this.attempts.push(structuredClone(request));
      if (seenOnly(request)) {
        if (++this.seenAttempts === 1) {
          // Batch A commits at Core, but the renderer never receives its receipt.
          await super.invoke<T>(name, args);
          throw new Error('Seen receipt lost after commit');
        }
        // Batch B has already captured A's committed revision; hold its response.
        await this.secondSeen.promise;
      } else if (entries(request).some(entry => entry.kind === 'upsert_draft')) {
        ++this.draftAttempts;
        if (this.draftAttempts > 1 && this.foreignDraftConflicts > 0) {
          --this.foreignDraftConflicts;
          this.preferences.global.pinned = !this.preferences.global.pinned;
          ++this.preferences.revision;
        }
      }
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
  const transport = new ProvenanceTransport();
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  const store = new NavigationStore(createDesktopService(transport));
  stores.push(store);
  await store.start();
  await store.opened.open(route).refresh();
  return { store, transport };
}
async function loseAAndStartB(store: NavigationStore, transport: ProvenanceTransport) {
  store.markItemSeen(route, '1');
  await vi.advanceTimersByTimeAsync(1000);
  expect(transport.seenAttempts).toBe(1);
  expect(transport.preferences.revision).toBe(2);
  expect(store.getSnapshot().preferences?.revision).toBe(1);
  store.markItemSeen(route, '2');
  await vi.advanceTimersByTimeAsync(1000);
  expect(transport.seenAttempts).toBe(2);
  expect(transport.attempts[1].command).toMatchObject({ command: 'preferences_patch', params: { expected_preferences_revision: 2 } });
  expect(transport.preferences.revision).toBe(2);
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-10-13T10:00:00.000Z'); });
afterEach(() => { stores.splice(0).forEach(store => store.stop()); vi.useRealTimers(); });

describe('seen commit provenance across lost receipts', () => {
  it('recognizes batch A before batch B replaces its capture while B remains in flight', async () => {
    const { store, transport } = await setup();
    await loseAAndStartB(store, transport);
    const committedA = structuredClone(transport.preferences);
    expect(sessionSeen(committedA, route)?.items.map(item => item.item_id)).toEqual(['1']);
    expect(store.preferenceWrites.seenOnlySince(1, committedA)).toBe(true);
    expect(store.getSnapshot()).toMatchObject({ writing: false, pendingOperationId: null, error: null });
    // A matching revision alone never proves a foreign preference change is ours.
    const foreign = structuredClone(committedA);
    foreign.revision += 1;
    foreign.global.pinned = true;
    expect(store.preferenceWrites.seenOnlySince(1, foreign)).toBe(false);
    transport.secondSeen.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionSeen(store.getSnapshot().preferences, route)?.items.map(item => item.item_id)).toEqual(['1', '2']);
    expect(store.getSnapshot().error).toBeNull();
  });

  it('keeps the full foreign-conflict retry allowance for a draft after the lost batch A receipt', async () => {
    const { store, transport } = await setup();
    const drafts = new OwnerDraftStore(store.service, () => crypto.randomUUID(), store.preferenceWrites);
    await drafts.load();
    const session = store.opened.get(route)!.getSnapshot().snapshot!.session;
    const draftId = drafts.begin(session, '2', 'answer')!;
    expect(draftId).toBeTruthy();
    const rendered = structuredClone(transport.preferences);
    await loseAAndStartB(store, transport);
    // A read captured before A committed reaches the draft writer after B begins.
    // The first real revision conflict is our seen write; the next two are foreign.
    transport.staleRead = rendered;
    transport.foreignDraftConflicts = 2;
    const saving = drafts.editSaved(draftId, { text: 'Retained reply' });
    await vi.advanceTimersByTimeAsync(500);
    expect(await saving).toBe(true);
    expect(transport.draftAttempts).toBe(4);
    expect(transport.preferences.drafts.find(draft => draft.op_id === draftId)?.text).toBe('Retained reply');
    expect(drafts.getSnapshot()).toMatchObject({ error: null, preferenceUncertain: false });
    expect(drafts.getSnapshot().entries[draftId]).toMatchObject({ uncertain: false, error: null });
    expect(store.getSnapshot()).toMatchObject({ writing: false, pendingOperationId: null, error: null });
    transport.secondSeen.release();
    await vi.advanceTimersByTimeAsync(0);
  });
});
