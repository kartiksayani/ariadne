import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import demo from '../../../../../fixtures/domain/demo/session.json';
import inventory from '../../../../../fixtures/contracts/core/inventory.json';
import projects from '../../../../../fixtures/domain/projections/projects.json';
import sessions from '../../../../../fixtures/domain/projections/sessions.json';
import type { Session } from '../../../src/generated/domain/models';
import type { OwnerMutationRequest, PreferencesSnapshot, QueryEnvelope, SessionPreferences } from '../../../src/generated/core';
import { OpenSessions } from '../../../src/data/session-store';
import { RegisteredRoutes, type RevealedItem } from '../../../src/data/routes';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { SessionTopicGraph } from '../../../src/components/graph/SessionTopicGraph';
import { NavigationTopicGraph } from '../../../src/components/graph/NavigationTopicGraph';
import { NavigationStore } from '../../../src/state/navigation/store';

const route = { project_id: demo.project_id, session_id: demo.id }, topic = demo.items['1'].topic_id;
const opened: OpenSessions[] = [];
const navigationStores: NavigationStore[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(value => value.closeAll()); navigationStores.splice(0).forEach(value => value.stop()); vi.restoreAllMocks(); });
function preferences(): SessionPreferences {
  return { session: route, tab_open: true, selected_item_id: '1', tab_order: 0, expanded_item_ids: [],
    filters: { search: '', statuses: [], owners: [], topic_id: null, archived: false, hide_later: false }, rail: 'waiting', scroll: null };
}
async function setup(view = preferences(), session = structuredClone(demo) as Session) {
  const calls: { command: string; request: Parameters<DesktopTransport['invoke']>[1]['request'] }[] = [];
  let missing = false, unavailable = false, finish: (() => void) | null = null, delay = false;
  const transport: DesktopTransport = {
    async invoke<T>(command: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
      calls.push({ command, request: structuredClone(args.request) });
      if (command === 'reveal_item' && delay) await new Promise<void>(resolve => { finish = resolve; });
      if (unavailable || (missing && command === 'reveal_item')) return { api_version: 1, ok: false,
        error: { code: 'not_found', message: 'The registered item is missing.', hint: 'Read the registered session.', retryable: false, field_errors: [] } } as T;
      const request = args.request;
      const result = command === 'session_get' ? { session: structuredClone(session), freshness: 'fresh' }
        : { ...route, item_id: 'request' in request ? (request.request.params as { item_id: string }).item_id : '1' };
      return { api_version: 1, ok: true, data: { kind: command, data: result } } as QueryEnvelope as T;
    },
    async listen() { return () => {}; },
  };
  const service = createDesktopService(transport), sessions = new OpenSessions(service); opened.push(sessions);
  const store = sessions.open(route); await store.refresh();
  const routes = new RegisteredRoutes(service, sessions), saved: string[] = [], reveals: RevealedItem[] = [], switchTree = vi.fn();
  function Composition({ topicId = topic, externalReveal = null }: { topicId?: string; externalReveal?: RevealedItem | null }) {
    const [current, setCurrent] = useState(view);
    return <SessionTopicGraph store={store} routes={routes} topicId={topicId} view={current} later={new Set()} reveal={externalReveal}
      onReveal={result => { reveals.push(result); }} onSwitchToTree={switchTree}
      saveSelection={async id => { saved.push(id); setCurrent(previous => ({ ...previous, selected_item_id: id })); return true; }} />;
  }
  return { Composition, store, routes, session, calls, saved, reveals, switchTree,
    missing: () => { missing = true; }, unavailable: () => { unavailable = true; },
    delay: () => { delay = true; }, finish: () => { finish?.(); } };
}
const nodes = () => Array.from(document.querySelectorAll<SVGGElement>('[data-graph-node]'));
const ids = () => nodes().map(node => node.dataset.graphNode);
const node = (id: string) => nodes().find(value => value.dataset.graphNode === id)!;
describe('registered selected-topic graph', () => {
  it('renders the complete topic independently of tree expansion, with complete accessible text and fixed nodes', async () => {
    const value = await setup(); value.session.items['1']!.question = 'A complete sentence far longer than the two-line graph preview, with retained detail text.';
    value.session.revision++; await value.store.refresh(); render(<value.Composition />);
    expect(ids()).toEqual(['1', '1.1', '2', '3', '4', '5', '6', '7']);
    expect(node('1').getAttribute('aria-label')).toContain(value.session.items['1']!.question);
    expect(node('1').querySelector('title')?.textContent).toBe(value.session.items['1']!.question);
    expect(node('1').querySelector('rect')?.getAttribute('width')).toBe('190');
    expect(node('1').querySelector('rect')?.getAttribute('height')).toBe('66');
    expect(document.querySelector('[data-edge="parent:1:1.1"] path')?.getAttribute('d')).toContain(' C ');
    expect(document.querySelector('[data-edge="replacement:7:4"] path')?.getAttribute('stroke-dasharray')).toBe('4 4');
    expect(screen.getByText('replaced by', { selector: 'text' })).toBeTruthy();
    expect(value.saved).toEqual([]);
  });
  it('uses exact shared filter membership and ordinary ancestor context without injecting replacement targets', async () => {
    const view = preferences(); view.filters.statuses = ['replaced', 'open']; view.filters.search = 'receipt lookup test';
    const value = await setup(view); render(<value.Composition />);
    expect(ids()).toEqual(['1', '1.1']);
    expect(node('1').classList.contains('topic-graph-context')).toBe(true);
    expect(document.querySelector('[data-edge^="replacement:"]')).toBeNull();
    expect(value.saved).toEqual([]);
  });
  it.each(['hidden', 'cross-topic'] as const)('keeps a %s replacement accessible through the registered route without an edge', async kind => {
    const view = preferences(); view.filters.statuses = ['replaced'];
    const session = structuredClone(demo) as Session; if (kind === 'cross-topic') session.items['7']!.replaced_by = '8';
    const value = await setup(view, session); render(<value.Composition />);
    expect(ids()).toEqual(['7']); expect(document.querySelector('[data-edge^="replacement:"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: session.items[kind === 'hidden' ? '4' : '8']!.question }));
    await waitFor(() => expect(value.reveals).toHaveLength(1));
    expect(value.calls.find(call => call.command === 'reveal_item')?.request).toEqual({ session: route,
      request: { command: 'reveal_item', params: { item_id: kind === 'hidden' ? '4' : '8' } } });
    expect(ids()).toEqual(['7']); expect(view.filters.statuses).toEqual(['replaced']);
    expect(screen.getByText(/selected item is outside this filtered topic/)).toBeTruthy();
  });
  it('rejects a missing or mismatched topic without rewriting saved filters', async () => {
    const view = preferences(); view.filters.topic_id = demo.items['8'].topic_id;
    const value = await setup(view), rendered = render(<value.Composition />);
    expect(ids()).toEqual([]); expect(screen.getByText(/matches the shared topic filter/)).toBeTruthy();
    rendered.rerender(<value.Composition topicId="00000000-0000-4000-8000-000000000099" />);
    expect(ids()).toEqual([]); expect(value.saved).toEqual([]);
  });
  it('opens the shared registered detail on Enter and highlights only its parent ancestry', async () => {
    const value = await setup(); render(<value.Composition />);
    fireEvent.keyDown(node('1.1'), { key: 'Enter' });
    await waitFor(() => expect(value.saved).toEqual(['1.1']));
    expect(node('1.1').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-edge="parent:1:1.1"] path')?.getAttribute('stroke-width')).toBe('1.75');
    expect(document.querySelector('[data-edge="replacement:7:4"] path')?.getAttribute('stroke-width')).toBe('1.25');
    expect(value.reveals).toHaveLength(1);
  });
  it('retains last valid nodes on read failure and shows registered missing-item fallback without invented selection', async () => {
    const value = await setup(); render(<value.Composition />); const before = ids(); value.missing();
    fireEvent.click(node('1.1')); await waitFor(() => expect(value.reveals[0]?.kind).toBe('missing_item'));
    expect(screen.getByText('The registered item is missing.')).toBeTruthy(); expect(value.saved).toEqual([]);
    value.unavailable(); await act(async () => { await value.store.refresh(); });
    expect(ids()).toEqual(before); expect(screen.getAllByText('The registered item is missing.')).toHaveLength(2);
  });
  it('ignores a delayed reveal after the selected topic changes', async () => {
    const value = await setup(), rendered = render(<value.Composition />); value.delay();
    fireEvent.click(node('1.1')); await waitFor(() => expect(value.calls.some(call => call.command === 'reveal_item')).toBe(true));
    rendered.rerender(<value.Composition topicId={demo.items['8'].topic_id} />);
    await act(async () => { value.finish(); });
    expect(ids()).toEqual(['8']); expect(value.reveals).toEqual([]); expect(value.saved).toEqual([]);
  });
  it('anchors wheel zoom, clamps controls and offers the accessible tree route', async () => {
    const value = await setup(); render(<value.Composition />);
    const canvas = screen.getByLabelText('Topic sentences'), world = document.querySelector('[data-graph-world]')!;
    fireEvent.wheel(canvas, { clientX: 100, clientY: 120, deltaY: -100000 });
    expect(screen.getByRole('status').textContent).toBe('200%');
    expect((screen.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement).disabled).toBe(true);
    const before = world.getAttribute('transform'); fireEvent.wheel(canvas, { clientX: 100, clientY: 120, deltaY: 100000 });
    expect(screen.getByRole('status').textContent).toBe('25%'); expect(world.getAttribute('transform')).not.toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'Fit' })); expect(world.getAttribute('transform')).not.toContain('scale(0.25)');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to tree' })); expect(value.switchTree).toHaveBeenCalledOnce();
    expect(value.saved).toEqual([]);
  });
  it('pans only the primary pointer on blank canvas and stops after cancellation', async () => {
    const value = await setup(); render(<value.Composition />);
    const canvas = screen.getByLabelText('Topic sentences'), world = document.querySelector('[data-graph-world]')!;
    const pointer = (target: Element, type: string, x: number, y: number, id = 1, button = 0) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button });
      Object.defineProperty(event, 'pointerId', { value: id }); fireEvent(target, event);
    };
    const transform = () => world.getAttribute('transform')!;
    const original = transform();
    pointer(node('1'), 'pointerdown', 10, 10); pointer(canvas, 'pointermove', 30, 40); expect(transform()).toBe(original);
    pointer(canvas, 'pointerdown', 10, 10, 1, 2); pointer(canvas, 'pointermove', 30, 40); expect(transform()).toBe(original);
    pointer(canvas, 'pointerdown', 10, 10); pointer(canvas, 'pointermove', 30, 40, 2); expect(transform()).toBe(original);
    pointer(canvas, 'pointermove', 30, 40); const moved = transform(); expect(moved).not.toBe(original);
    pointer(canvas, 'pointercancel', 30, 40); pointer(canvas, 'pointermove', 60, 70); expect(transform()).toBe(moved);
    fireEvent.click(screen.getByRole('button', { name: 'Fit' })); expect(transform()).toBe(original);
    expect(value.saved).toEqual([]);
  });
  it('fits the actual initial canvas size rather than the fallback dimensions', async () => {
    vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0,
      right: 200, bottom: 420, width: 200, height: 420, toJSON: () => ({}) });
    const value = await setup(); render(<value.Composition />);
    expect(screen.getByRole('status').textContent).toBe('31%');
    const before = document.querySelector('[data-graph-world]')!.getAttribute('transform');
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(document.querySelector('[data-graph-world]')!.getAttribute('transform')).toBe(before);
  });
  it('keeps a pending preference operation scoped and does not enqueue automatic selection retries', async () => {
    const value = await setup(), saved: string[] = [];
    let finish!: (confirmed: boolean) => void;
    const props = { store: value.store, routes: value.routes, view: preferences(), later: new Set<string>(), onReveal: () => {}, onSwitchToTree: () => {},
      saveSelection: async (id: string) => { saved.push(id); if (saved.length === 1) return new Promise<boolean>(resolve => { finish = resolve; }); return true; } };
    const rendered = render(<SessionTopicGraph {...props} topicId={topic} />);
    fireEvent.click(node('1.1')); await waitFor(() => expect(saved).toEqual(['1.1']));
    fireEvent.click(node('2')); await screen.findByText('Refresh the current preferences before saving another selection.');
    expect(saved).toEqual(['1.1']);
    rendered.rerender(<SessionTopicGraph {...props} topicId={demo.items['8'].topic_id} />);
    fireEvent.click(node('8')); await waitFor(() => expect(saved).toEqual(['1.1', '8']));
    await act(async () => { finish(false); }); expect(screen.queryByRole('alert')).toBeNull();
    expect(saved).toEqual(['1.1', '8']);
  });
  it('persists shared graph selection through the real navigation writer with its captured revision', async () => {
    const params = inventory.owner_commands.find(value => value.command === 'preferences_patch')!.params as {
      entries: { preferences?: unknown; draft?: unknown }[] };
    const prefs: PreferencesSnapshot = { schema_version: 1, revision: 7,
      global: { ...(structuredClone(params.entries[0].preferences) as PreferencesSnapshot['global']), selected_navigation: { kind: 'session', session: route } },
      sessions: [preferences(), { ...preferences(), session: { ...route, session_id: '00000000-0000-4000-8000-000000000099' }, tab_open: false }],
      later: [{ ...route, item_id: '2' }], drafts: [structuredClone(params.entries.find(value => value.draft)!.draft) as PreferencesSnapshot['drafts'][number]] };
    const before = structuredClone(prefs), mutations: OwnerMutationRequest[] = [];
    const transport: DesktopTransport = {
      async invoke<T>(command: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
        if (command === 'preferences_patch') {
          const request = args.request as OwnerMutationRequest; mutations.push(structuredClone(request));
          if (request.command.command !== 'preferences_patch') throw new Error('Unexpected owner command.');
          for (const entry of request.command.params.entries) {
            if (entry.kind !== 'set_session_view') throw new Error('Graph selection must change only its saved view.');
            prefs.sessions[0] = entry.preferences;
          }
          prefs.revision++;
          return { api_version: 1, ok: true, data: { operation_id: request.command.op_id, preferences_revision: prefs.revision } } as T;
        }
        const request = args.request;
        const data = command === 'preferences_get' ? structuredClone(prefs)
          : command === 'project_list' ? { projects: structuredClone(projects), counts: structuredClone(sessions.items[0].counts) }
          : command === 'session_list' ? { sessions: structuredClone(sessions), counts: structuredClone(sessions.items[0].counts), active_total: 1, closed_total: 0 }
          : command === 'session_get' ? { session: structuredClone(demo), freshness: 'fresh' }
          : { ...route, item_id: 'request' in request ? (request.request.params as { item_id: string }).item_id : '1' };
        return { api_version: 1, ok: true, data: { kind: command, data } } as T;
      },
      async listen() { return () => {}; },
    };
    const navigation = new NavigationStore(createDesktopService(transport), () => '00000000-0000-4000-8000-000000000400'); navigationStores.push(navigation);
    await navigation.refresh(); const store = navigation.opened.open(route); await store.refresh();
    render(<NavigationTopicGraph navigation={navigation} store={store} topicId={topic} onReveal={() => {}} onSwitchToTree={() => {}} />);
    fireEvent.keyDown(node('1.1'), { key: 'Enter' });
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0].session).toBeNull();
    expect(mutations[0].command).toMatchObject({ command: 'preferences_patch', params: {
      expected_preferences_revision: 7, entries: [{ kind: 'set_session_view', preferences: { ...before.sessions[0], selected_item_id: '1.1' } }] } });
    await waitFor(() => expect(navigation.getSnapshot().preferences?.revision).toBe(8));
    expect(prefs.sessions[1]).toEqual(before.sessions[1]); expect(prefs.global).toEqual(before.global);
    expect(prefs.later).toEqual(before.later); expect(prefs.drafts).toEqual(before.drafts);
  });
});
