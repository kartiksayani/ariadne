import { StrictMode } from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import demo from '../../../../../fixtures/domain/demo/session.json';
import projects from '../../../../../fixtures/domain/projections/projects.json';
import sessions from '../../../../../fixtures/domain/projections/sessions.json';
import inventory from '../../../../../fixtures/contracts/core/inventory.json';
import type { DesktopDiscoveryCandidate, DesktopDiscoverySnapshot, OwnerMutationRequest, PreferencesSnapshot } from '../../../src/generated/core';
import type { ProjectSummary, Session, SessionSummary } from '../../../src/generated/domain/models';
import { createDesktopService, type DesktopTransport } from '../../../src/data/service';
import { DiscoveryController } from '../../../src/data/discovery';
import { NavigationStore } from '../../../src/state/navigation/store';
import { BindSession } from '../../../src/components/navigation/Registration';
import { NavigationWorkspace, type AdapterChoice } from '../../../src/components/navigation/NavigationWorkspace';

const adapter: AdapterChoice = { adapter_id: 'codex', label: 'Codex', configuration: { namespace: 'codex', values: {} } };
const root = projects.items[0].canonical_root;
const candidate = (id = 'discovered-thread', endpoint = '/tmp/daemon.sock'): DesktopDiscoveryCandidate => ({
  adapter_id: 'codex', endpoint: { kind: 'unix_socket', path: endpoint }, external_session_id: id,
  cwd: root, title: 'Discovered conversation', host_version: 'fixture', observed_at: demo.updated_at,
  freshness: 'fresh', compatibility: 'unknown', availability: 'unknown', loaded: true, binding_id: null, session: null,
});
const lifetimes: { store: NavigationStore; controller: DiscoveryController }[] = [];
afterEach(() => { cleanup(); lifetimes.splice(0).forEach(({ store, controller }) => { controller.dispose(); store.stop(); }); });
function setup() {
  const prefs = inventory.owner_commands.find(command => command.command === 'preferences_patch')!.params as { entries: { preferences?: unknown }[] };
  let preferences: PreferencesSnapshot = { schema_version: 1, revision: 1, global: structuredClone(prefs.entries[0].preferences) as PreferencesSnapshot['global'], sessions: [], later: [], drafts: [] };
  preferences.global.selected_navigation = { kind: 'projects' };
  const reads = vi.fn<() => Promise<DesktopDiscoverySnapshot>>().mockResolvedValue({ candidates: [candidate()], error: null });
  const opens = vi.fn<(open: boolean) => Promise<void>>().mockResolvedValue();
  const mutations: OwnerMutationRequest[] = [];
  let uncertain = false;
  const transport: DesktopTransport = {
    discovery: reads, setConnectionUiOpen: opens, listen: async () => () => {},
    async invoke<T>(name: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
      if ('command' in args.request) {
        const request = structuredClone(args.request); mutations.push(request);
        if (name === 'project_register') return { api_version: 1, ok: true, data: { operation_id: request.command.op_id, project_id: demo.project_id, registry_revision: 2 } } as T;
        if (request.command.command === 'preferences_patch') {
          for (const entry of request.command.params.entries) if (entry.kind === 'set_global') preferences = { ...preferences, revision: preferences.revision + 1, global: entry.preferences };
          return { api_version: 1, ok: true, data: { operation_id: request.command.op_id, preferences_revision: preferences.revision } } as T;
        }
        if (name === 'binding_connect') {
          if (uncertain) { uncertain = false; throw new Error('Lost acknowledgement'); }
          const binding = Object.values((demo as Session).bindings)[0]!;
          return { api_version: 1, ok: true, data: { operation_id: request.command.op_id, session_id: demo.id, revision: 22,
            data: { kind: 'binding_connect', binding_id: binding.id, generation: binding.generation, capabilities: binding.capabilities, setup_instruction: 'Saved setup' } } } as T;
        }
        throw new Error(`Unexpected mutation ${name}`);
      }
      const data = name === 'preferences_get' ? preferences : name === 'project_list' ? { projects, counts: projects.items[0].counts }
        : { sessions, counts: sessions.items[0].counts, active_total: 9, closed_total: 3 };
      return { api_version: 1, ok: true, data: { kind: name, data } } as T;
    },
  };
  const service = createDesktopService(transport), store = new NavigationStore(service), controller = new DiscoveryController(service);
  lifetimes.push({ store, controller });
  return { store, controller, reads, opens, mutations, loseNextConnect: () => { uncertain = true; } };
}
const bind = (context: ReturnType<typeof setup>, strict = false) => {
  const element = <BindSession store={context.store} discovery={context.controller} project={projects.items[0] as ProjectSummary}
    sessions={sessions.items as SessionSummary[]} adapters={[adapter]} disabled={false} close={vi.fn()} />;
  return render(strict ? <StrictMode>{element}</StrictMode> : element);
};

describe('explicit discovery registration and binding', () => {
  it('expansion reads without persistence; Register only prefills and submit opens the returned canonical project', async () => {
    const context = setup(); await context.store.start();
    render(<NavigationWorkspace store={context.store} discovery={context.controller} adapterChoices={[adapter]} renderSession={() => null} />);
    expect(context.opens).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discover host sessions' }));
    await screen.findByText('Discovered conversation'); expect(context.mutations).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Register this project' }));
    expect(screen.getByLabelText('Project root')).toHaveValue(root); expect(context.mutations).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Register project' }).at(-1)!); });
    expect(context.mutations[0].command).toMatchObject({ command: 'project_register', params: { canonical_root: root } });
    expect(context.store.getSnapshot().preferences?.global.selected_navigation).toEqual({ kind: 'project', project_id: demo.project_id });
    expect(context.mutations.some(request => request.command.command === 'binding_connect')).toBe(false);
    await waitFor(() => expect(context.opens.mock.calls.at(-1)).toEqual([false]));
  });
  it('shows an untested host version notice and accepts the untested compatibility value', async () => {
    const context = setup(); await context.store.start();
    context.reads.mockResolvedValue({ candidates: [{ ...candidate(), host_version: '0.160.1', compatibility: 'untested' }], error: null });
    bind(context);
    await screen.findByText('Discovered conversation');
    expect(screen.getByRole('note')).toHaveTextContent('Codex 0.160.1 is newer than the tested version; it should work, but has not been verified.');
    expect(screen.getByText(/untested/)).toBeInTheDocument();
  });
  it('selection preserves the explicit existing Ariadne UUID and Connect retry retains its immutable request', async () => {
    const context = setup(); await context.store.start(); context.loseNextConnect(); bind(context);
    await screen.findByText('Discovered conversation');
    fireEvent.click(screen.getByLabelText('Attach to an existing Ariadne session'));
    fireEvent.change(screen.getByLabelText('Registered Ariadne session'), { target: { value: demo.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Use host session' }));
    expect(screen.getByLabelText('External session ID')).toHaveValue('discovered-thread'); expect(context.mutations).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect existing session' })); });
    const original = structuredClone(context.mutations[0]);
    expect(original.command).toMatchObject({ command: 'binding_connect', params: { adapter_id: 'codex', external_session_id: 'discovered-thread',
      endpoint: { kind: 'unix_socket', path: '/tmp/daemon.sock' }, existing_session_id: demo.id } });
    fireEvent.change(screen.getByLabelText('External session ID'), { target: { value: 'manual-edit-after-uncertain' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reconcile operation' })); });
    expect(context.mutations[1]).toEqual(original); expect(context.store.getSnapshot().setup?.data.kind).toBe('binding_connect');
  });
  it('refresh preserves manual fields and visibly invalidates a removed, stale or changed endpoint selection', async () => {
    const context = setup(); await context.store.start(); bind(context);
    await screen.findByText('Discovered conversation');
    fireEvent.change(screen.getByLabelText('External session ID'), { target: { value: 'manual-thread' } });
    fireEvent.change(screen.getByLabelText('Socket path'), { target: { value: '/manual.sock' } });
    await act(async () => { await context.controller.refresh(); });
    expect(screen.getByLabelText('External session ID')).toHaveValue('manual-thread'); expect(screen.getByLabelText('Socket path')).toHaveValue('/manual.sock');
    fireEvent.click(screen.getByRole('button', { name: 'Use host session' }));
    for (const replacement of [[], [{ ...candidate(), freshness: 'stale' as const }], [candidate('discovered-thread', '/different.sock')]]) {
      context.reads.mockResolvedValueOnce({ candidates: replacement, error: null });
      await act(async () => { await context.controller.refresh(); });
      expect(screen.getByText(/Selected host session is no longer fresh/)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Connect existing session' })).toBeDisabled();
      expect(screen.getByLabelText('Socket path')).toHaveValue('/tmp/daemon.sock');
    }
    await act(async () => { await context.controller.refresh(); });
    expect(screen.getByRole('button', { name: 'Connect existing session' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Use host session' }));
    expect(screen.getByRole('button', { name: 'Connect existing session' })).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('External session ID'), { target: { value: 'manual-fallback' } });
    expect(screen.getByRole('button', { name: 'Connect existing session' })).not.toBeDisabled(); expect(context.mutations).toHaveLength(0);
  });
  it('failed refresh retains a visible complete snapshot and dismissal closes StrictMode replay', async () => {
    const context = setup(); await context.store.start(); bind(context, true);
    await screen.findByText('Discovered conversation');
    context.reads.mockRejectedValueOnce(new Error('unavailable'));
    await act(async () => { await context.controller.refresh(); });
    expect(screen.getByText('Discovered conversation')).toBeTruthy(); expect(screen.getByText(/Discovery could not refresh/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use host session' })).toBeDisabled();
    cleanup(); await waitFor(() => expect(context.opens.mock.calls.at(-1)).toEqual([false]));
    expect(context.mutations).toHaveLength(0);
  });
});
