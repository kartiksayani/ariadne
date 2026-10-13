import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerMutationRequest } from '../../../src/generated/core';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { NavigationStore } from '../../../src/state/navigation/store';
import { sessionSeen } from '../../../src/state/preferences/seen';
import { AppTransport, route } from '../app/transport';

type Patch = OwnerMutationRequest & { command: Extract<OwnerMutationRequest['command'], { command: 'preferences_patch' }> };
const isPatch = (request: OwnerMutationRequest): request is Patch => request.command.command === 'preferences_patch';
const isSeen = (request: OwnerMutationRequest) => isPatch(request) && request.command.params.entries.every(entry => entry.kind === 'mark_seen');
const isDraft = (request: OwnerMutationRequest): request is Patch => isPatch(request) && !isSeen(request);
const failure = (code: string, revision?: number) => ({ api_version: 1, ok: false, error: { code,
  message: 'Preferences changed or the result was lost.', hint: 'Reconcile before retrying.', retryable: false,
  field_errors: [], ...(revision === undefined ? {} : { current_revision: revision }) } });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Core's revision check and exact-operation replay around the shared app fixture. */
class CoordinatedTransport extends AppTransport {
  readonly started: OwnerMutationRequest[] = [];
  afterPreferencesRead: (() => Promise<void>) | null = null;
  beforePatch: ((request: Patch) => Promise<void>) | null = null;
  afterMutation: ((request: OwnerMutationRequest, result: unknown) => Promise<unknown>) | null = null;
  private readonly receipts = new Map<string, { request: OwnerMutationRequest; result: unknown }>();
  override async invoke<T>(name: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
    const request = args.request;
    if (!('command' in request)) {
      const result = await super.invoke<T>(name, args);
      if (request.request.command === 'preferences_get') {
        const afterRead = this.afterPreferencesRead;
        this.afterPreferencesRead = null;
        await afterRead?.();
      }
      return result;
    }
    this.started.push(structuredClone(request));
    const recorded = this.receipts.get(request.command.op_id);
    if (recorded) {
      expect(request).toEqual(recorded.request);
      this.mutations.push(structuredClone(request));
      return structuredClone(recorded.result) as T;
    }
    if (isPatch(request)) {
      await this.beforePatch?.(request);
      if (request.command.params.expected_preferences_revision !== this.preferences.revision) {
        this.mutations.push(structuredClone(request));
        return failure('revision_conflict', this.preferences.revision) as T;
      }
    }
    const result = await super.invoke<T>(name, args);
    this.receipts.set(request.command.op_id, { request: structuredClone(request), result: structuredClone(result) });
    return (this.afterMutation ? await this.afterMutation(request, result) : result) as T;
  }
}

const stores: NavigationStore[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-10-13T10:00:00.000Z'); });
afterEach(() => { stores.splice(0).forEach(store => store.stop()); vi.restoreAllMocks(); vi.useRealTimers(); });
async function setup() {
  const transport = new CoordinatedTransport(), service = createDesktopService(transport);
  const navigation = new NavigationStore(service);
  stores.push(navigation);
  // Refresh subscribes without installing the unrelated 2-second polling timer.
  await navigation.refresh();
  await navigation.opened.open(route).refresh();
  const drafts = new OwnerDraftStore(service, undefined, navigation.preferenceWrites);
  await drafts.load();
  const session = transport.sessions.get(route.session_id)!;
  const id = drafts.begin(session, '8', 'reply')!;
  expect(id).toBeTruthy();
  return { transport, navigation, drafts, session, id };
}

describe('draft and seen preference coordination', () => {
  it('rebases a seen commit between draft read and patch repeatedly, then sends exactly one input', async () => {
    const { transport, navigation, drafts, session, id } = await setup();
    const errors: unknown[] = [];
    const unsubscribe = drafts.subscribe(() => { const error = drafts.getSnapshot().error; if (error) errors.push(error); });
    let conflicts = 0;
    const classify = vi.spyOn(navigation.preferenceWrites, 'seenOnlySince');
    // The reservation admits at most one existing seen flight per save. Repeat
    // the real race across edits and Send rather than inventing queued flights.
    for (const text of ['A', 'AB', 'ABC', 'Final reply', null]) {
      const commit = deferred(), committed = deferred(), receipt = deferred();
      transport.beforePatch = async request => { if (isSeen(request)) await commit.promise; };
      transport.afterMutation = async (request, result) => {
        if (isSeen(request)) { committed.resolve(); await receipt.promise; }
        return result;
      };
      navigation.markTopicCaughtUp(route, session.items['8']!.topic_id);
      await vi.advanceTimersByTimeAsync(1000);
      transport.afterPreferencesRead = async () => { commit.resolve(); await committed.promise; };
      const offset = transport.started.length;
      const saving = text === null ? drafts.submit(id) : drafts.editSaved(id, { text });
      await vi.advanceTimersByTimeAsync(500);
      // Send performs another reserved preferences write to remove its draft;
      // the deliberately held seen receipt also bounds that cleanup wait.
      if (text === null) await vi.advanceTimersByTimeAsync(500);
      expect(await saving).toBe(true);
      const attempts = transport.started.slice(offset).filter(isDraft);
      // Send also deletes the now-confirmed draft after its successful input.
      expect(attempts).toHaveLength(text === null ? 3 : 2);
      expect(attempts[0].command.params.entries).toEqual(attempts[1].command.params.entries);
      expect(attempts[0].command.op_id).not.toBe(attempts[1].command.op_id);
      expect(attempts[1].command.params.expected_preferences_revision)
        .toBe(attempts[0].command.params.expected_preferences_revision + 1);
      conflicts++;
      expect(drafts.getSnapshot().error).toBeNull();
      if (text !== null) expect(transport.preferences.drafts.find(draft => draft.op_id === id)?.text).toBe(text);
      receipt.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(conflicts).toBe(5);
    expect(classify).toHaveBeenCalledTimes(5);
    expect(classify.mock.results.every(result => result.value === true)).toBe(true);
    const inputs = transport.started.filter(request => request.command.command === 'input_submit');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ command: { op_id: id, params: { text: 'Final reply', kind: 'reply' } } });
    expect(Object.values(session.inputs).filter(input => input?.payload.text === 'Final reply')).toHaveLength(1);
    expect(transport.preferences.drafts).toEqual([]);
    expect(sessionSeen(transport.preferences, route)?.topics.map(topic => topic.topic_id)).toContain(session.items['8']!.topic_id);
    unsubscribe();
    expect(errors).toEqual([]);
  });

  it('admits a draft after exactly 500 ms when a seen response remains held', async () => {
    const { transport, navigation, drafts, id } = await setup();
    const held = deferred();
    transport.beforePatch = async request => { if (isSeen(request)) await held.promise; };
    navigation.markItemSeen(route, '8');
    await vi.advanceTimersByTimeAsync(1000);
    const saving = drafts.editSaved(id, { text: 'Owner goes first' });
    await vi.advanceTimersByTimeAsync(499);
    expect(transport.started.filter(isDraft)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await saving).toBe(true);
    expect(transport.started.filter(isDraft)).toHaveLength(1);
    expect(transport.preferences.drafts[0].text).toBe('Owner goes first');
    held.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sessionSeen(transport.preferences, route)?.items).toContainEqual({ item_id: '8', revision: transport.sessions.get(route.session_id)!.items['8']!.revision });
  });

  it.each(['read', 'patch'] as const)('starts no seen batch while a draft %s is held', async phase => {
    const { transport, navigation, drafts, id } = await setup();
    const held = deferred(), entered = deferred();
    if (phase === 'read') transport.afterPreferencesRead = async () => { entered.resolve(); await held.promise; };
    else transport.beforePatch = async request => { if (isDraft(request)) { entered.resolve(); await held.promise; } };
    const saving = drafts.editSaved(id, { text: 'Keep writing' });
    await entered.promise;
    navigation.markItemSeen(route, '8');
    await vi.advanceTimersByTimeAsync(1500);
    expect(transport.started.filter(isSeen)).toHaveLength(0);
    held.resolve();
    expect(await saving).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.started.filter(isSeen)).toHaveLength(1);
    expect(transport.preferences.drafts[0].text).toBe('Keep writing');
    expect(transport.mutations.filter(isPatch).map(request => isSeen(request) ? 'seen' : 'draft')).toEqual(['draft', 'seen']);
  });

  it.each([2, 3])('retains the three-attempt foreign conflict bound with %s conflicting writes', async count => {
    const { transport, drafts, id } = await setup();
    expect(await drafts.editSaved(id, { text: 'Bounded reply' })).toBe(true);
    let conflicts = 0;
    transport.beforePatch = async request => {
      if (isDraft(request) && conflicts < count) {
        conflicts++;
        transport.preferences.global.pinned = !transport.preferences.global.pinned;
        transport.preferences.revision++;
      }
    };
    const offset = transport.started.length;
    expect(await drafts.submit(id)).toBe(count === 2);
    const attempts = transport.started.slice(offset).filter(isDraft);
    expect(attempts).toHaveLength(count === 2 ? 4 : 3); // Successful Send includes cleanup.
    expect(new Set(attempts.slice(0, 3).map(request => request.command.op_id)).size).toBe(3);
    expect(conflicts).toBe(count);
    expect(transport.started.filter(request => request.command.command === 'input_submit')).toHaveLength(count === 2 ? 1 : 0);
    if (count === 3) {
      expect(drafts.getSnapshot().error).toMatchObject({ error: { code: 'revision_conflict' } });
      expect(transport.preferences.drafts[0]).toMatchObject({ text: 'Bounded reply', submission_attempted: false });
    }
  });

  it('does not charge classified seen conflicts against the foreign retry budget', async () => {
    const { transport, navigation, drafts, id } = await setup();
    const errors: unknown[] = [];
    const unsubscribe = drafts.subscribe(() => { const error = drafts.getSnapshot().error; if (error) errors.push(error); });
    // Unit-test the classification seam beyond the single-flight integrated
    // scenario above: four seen classifications, then two foreign conflicts.
    const classify = vi.spyOn(navigation.preferenceWrites, 'seenOnlySince')
      .mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true)
      .mockReturnValue(false);
    let conflicts = 0;
    transport.beforePatch = async () => { if (conflicts++ < 6) transport.preferences.revision++; };
    expect(await drafts.editSaved(id, { text: 'Retry budget survives' })).toBe(true);
    expect(transport.started.filter(isDraft)).toHaveLength(7);
    expect(classify).toHaveBeenCalledTimes(6);
    expect(transport.preferences.drafts[0].text).toBe('Retry budget survives');
    expect(transport.started.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
    expect(drafts.getSnapshot().error).toBeNull();
    unsubscribe();
    expect(errors).toEqual([]);
  });

  it.each(['preferences_patch', 'input_submit'] as const)('replays an uncertain %s with its exact operation and avoids duplicate input', async command => {
    const { transport, drafts, session, id } = await setup();
    expect(await drafts.editSaved(id, { text: 'One exact message' })).toBe(true);
    let uncertain: OwnerMutationRequest | null = null;
    transport.afterMutation = async (request, result) => {
      if (!uncertain && request.command.command === command) {
        uncertain = structuredClone(request);
        return failure('commit_uncertain');
      }
      return result;
    };
    expect(await drafts.submit(id)).toBe(false);
    expect(uncertain).not.toBeNull();
    const lostOperation = transport.started.at(-1)!;
    expect(lostOperation).toEqual(uncertain);
    if (command === 'preferences_patch') {
      expect(drafts.getSnapshot().preferenceUncertain).toBe(true);
      expect(transport.started.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
      const revision = transport.preferences.revision;
      expect(await drafts.retryPreferences()).toBe(true);
      expect(transport.preferences.revision).toBe(revision);
      expect(transport.started.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
    }
    const sending = drafts.submit(id);
    expect(drafts.submit(id)).toBe(sending);
    expect(await sending).toBe(true);
    const replays = transport.started.filter(request => request.command.op_id === lostOperation.command.op_id);
    expect(replays).toHaveLength(2);
    expect(replays[1]).toEqual(replays[0]);
    expect(Object.values(session.inputs).filter(input => input?.payload.text === 'One exact message')).toHaveLength(1);
    expect(transport.preferences.drafts).toEqual([]);
    expect(drafts.getSnapshot()).toMatchObject({ preferenceUncertain: false, error: null });
  });
});
