import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route } from './transport';

afterEach(() => { cleanup(); notices.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('queued navigation in the current tree', () => {
  it('keeps all expanded rows, focus and scroll with no animation frames while the newest destination waits', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    const template = session.items['1']!, topic = session.topics[template.topic_id]!;
    session.items = {}; session.topics = { [topic.id]: topic };
    session.inputs = {}; session.messages = []; session.answers = []; session.rounds = {};
    const expected: string[] = [], expanded: string[] = [];
    for (let root = 1; root <= 20; ++root) {
      expanded.push(String(root));
      for (let child = 0; child < 10; ++child) {
        const id = child ? `${root}.${child}` : String(root);
        expected.push(id);
        session.items[id] = { ...template, id, parent: child ? String(root) : null, ordinal: child || root,
          question: `Tree entry ${id}`, status: 'open', owner: { kind: 'agent', binding_id: session.active_binding_id! }, current_round_id: null,
          options: [], links: [], status_history: [] };
      }
    }
    transport.preferences.global.selected_navigation = { kind: 'session', session: route };
    Object.assign(transport.preferences.sessions[0], { tab_open: true, expanded_item_ids: expanded });
    render(<DesktopApp service={createDesktopService(transport)} />);
    await screen.findByRole('region', { name: 'Session tree' });
    await waitFor(() => expect(screen.getByLabelText('Session').getAttribute('aria-busy')).toBe('false'));
    const tree = screen.getByRole('tree', { name: 'Session items' });
    const rows = () => [...tree.querySelectorAll<HTMLElement>('.tree-item')];
    const originalRows = rows();
    expect(originalRows.map(row => row.dataset.itemId)).toEqual(expected);
    const focused = originalRows[104]!;
    focused.focus(); tree.scrollTop = 2_000;
    let release!: () => void, writing = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const invoke = transport.invoke.bind(transport);
    vi.spyOn(transport, 'invoke').mockImplementation(async (name, args) => {
      const request = args.request;
      if ('command' in request && request.command.command === 'preferences_patch'
        && request.command.params.entries.some(entry => entry.kind === 'set_global' && entry.preferences.theme === 'light')) {
        writing = true; await gate;
      }
      return invoke(name, args);
    });
    const header = document.querySelector<HTMLElement>('.shell-header')!;
    const theme = within(header).getByRole<HTMLButtonElement>('button', { name: 'Switch to light' });
    await waitFor(() => expect(theme.disabled).toBe(false));
    fireEvent.click(theme);
    await waitFor(() => expect(writing).toBe(true));
    fireEvent.click(within(document.querySelector<HTMLElement>('[aria-label="Projects and sessions"]')!).getByRole('button', { name: 'Projects' }));
    const opening = screen.getByText('Opening Projects…');
    expect(opening.closest('.nav-session-content')).toBeNull();
    expect(opening.closest('.shell-center-content')).toBe(tree.closest('.shell-center-content'));
    const css = readFileSync(resolve(__dirname, '../../../src/styles/navigation.css'), 'utf8');
    expect(css.split('.nav-opening {')[1]!.split('}')[0]).toContain('position: absolute;');
    const assertTree = () => {
      expect(screen.getByRole('tree', { name: 'Session items' })).toBe(tree);
      expect(rows()).toEqual(originalRows);
      expect(document.activeElement).toBe(focused);
      expect(tree.scrollTop).toBe(2_000);
    };
    assertTree();
    fireEvent.click(document.querySelector<HTMLButtonElement>(`.shell-tab-open[data-session-tab='${JSON.stringify([route.project_id, route.session_id])}']`)!);
    expect(screen.getByText('Opening the session…')).toBeTruthy();
    assertTree();
    await act(async () => { release(); });
    await waitFor(() => expect(screen.queryByText('Opening the session…')).toBeNull());
    assertTree();
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: route });
    expect(transport.mutations.some(request => request.command.command === 'preferences_patch'
      && request.command.params.entries.some(entry => entry.kind === 'set_global' && entry.preferences.selected_navigation.kind === 'projects'))).toBe(false);
  }, 10_000);
});
