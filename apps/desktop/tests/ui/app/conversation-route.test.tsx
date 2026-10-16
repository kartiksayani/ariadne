import { useLayoutEffect, type ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { NavigationWorkspace } from '../../../src/components/navigation/NavigationWorkspace';
import { notices } from '../../../src/ui/pages/notices';
import { AppTransport, route, secondId } from './transport';

type WorkspaceProps = ComponentProps<typeof NavigationWorkspace>;
const probe = vi.hoisted(() => ({ inspect: null as ((props: WorkspaceProps) => void) | null }));
vi.mock('../../../src/components/navigation/NavigationWorkspace', async original => {
  const actual = await original<typeof import('../../../src/components/navigation/NavigationWorkspace')>();
  return { ...actual, NavigationWorkspace: (props: WorkspaceProps) => {
    useLayoutEffect(() => { probe.inspect?.(props); });
    return <actual.NavigationWorkspace {...props} />;
  } };
});

afterEach(() => { probe.inspect = null; cleanup(); notices.clear(); vi.restoreAllMocks(); });

it('guards conversation targets and footer on the first render of a different session before effects clear the old route', async () => {
  const transport = new AppTransport(), first = transport.sessions.get(route.session_id)!;
  const other = structuredClone(first); other.id = secondId; other.title = 'Different session';
  transport.sessions.set(secondId, other);
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  Object.assign(transport.preferences.sessions[0], { tab_open: true, selected_item_id: '4' });
  transport.preferences.sessions.push({ ...transport.view(secondId), selected_item_id: '4' });
  render(<DesktopApp service={createDesktopService(transport)} />);
  await screen.findByRole('button', { name: 'Open the conversation in a bigger view' });
  fireEvent.click(screen.getByRole('button', { name: 'Open the conversation in a bigger view' }));
  // The dock's path switches the open conversation to its question, as the Waiting card did.
  const dock = screen.getByRole('region', { name: 'Answer dock' });
  fireEvent.click(within(dock).getByRole('button', { name: /^\d+ (more )?waiting$/ }));
  await waitFor(() => expect(dock.querySelector('.answer-dock-current [data-owner-input="2"]')).not.toBeNull());
  const crumbs = dock.querySelectorAll<HTMLButtonElement>('.dock-path .dock-link');
  fireEvent.click(crumbs[crumbs.length - 1]!);
  await waitFor(() => expect(screen.getByRole('region', { name: 'Item conversation' }).querySelector('[data-detail-item-id]')?.getAttribute('data-detail-item-id')).toBe('2'));
  let inspected = false;
  probe.inspect = props => {
    if (inspected || props.store.selectedSession()?.getSnapshot().route.session_id !== secondId) return;
    inspected = true;
    // Layout effects run before App's passive route cleanup. This is the render
    // which previously resolved the old conversation id against the new session.
    expect(props.conversation).toBeUndefined();
    const root = document.querySelector('.product-app')!;
    fireEvent.keyDown(root, { key: 'r' });
    fireEvent.keyDown(root, { key: 'Escape' });
  };
  await act(async () => { transport.emit('ariadne://route', { ...route, session_id: secondId, item_id: '4' }); });
  await waitFor(() => expect(inspected).toBe(true));
  await waitFor(() => expect(transport.queries.filter(request => request.session?.session_id === secondId && request.request.command === 'reveal_item')
    .every(request => request.request.command === 'reveal_item' && request.request.params.item_id === '4')).toBe(true));
  expect(transport.mutations.filter(request => request.command.command === 'input_submit')).toHaveLength(0);
  expect(screen.queryByRole('region', { name: 'Item conversation' })).toBeNull();
});
