// ui.json both ways (C7). A file main wrote with several open tabs opens here in its last active session, and
// everything this build writes is still readable by main's reader: core's DTOs deny unknown fields, and the
// contract schemas below are generated from those same DTOs (contracts/ and crates/ are unchanged by this work).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesktopService } from '../../../src/data/service';
import { DesktopApp } from '../../../src/App';
import type { PreferencesPatchEntry, PreferencesSnapshot } from '../../../src/generated/core';
import { AppTransport, route, secondId } from '../app/transport';

afterEach(() => { cleanup(); });

type Schema = { readonly [key: string]: unknown };
const schemaOf = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../../../contracts/generated/core/${name}.schema.json`), 'utf8')) as Schema;

/** The parts of JSON Schema the core contracts use for shape: objects that deny extra fields, unions, arrays, consts. */
function problems(value: unknown, schema: Schema, root: Schema, at = '$'): string[] {
  if (typeof schema.$ref === 'string') return problems(value, (root.$defs as Record<string, Schema>)[schema.$ref.replace('#/$defs/', '')]!, root, at);
  for (const key of ['oneOf', 'anyOf'] as const) {
    const branches = schema[key] as Schema[] | undefined;
    if (branches) return branches.some(branch => problems(value, branch, root, at).length === 0) ? [] : [`${at}: matches no ${key} branch`];
  }
  if ('const' in schema && value !== schema.const) return [`${at}: expected ${JSON.stringify(schema.const)}`];
  const types = ([] as unknown[]).concat(schema.type ?? []);
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  if (types.length && !types.includes(kind) && !(kind === 'integer' && types.includes('number'))) return [`${at}: ${kind} is not ${types.join('|')}`];
  if (kind === 'array' && schema.items) return (value as unknown[]).flatMap((entry, index) => problems(entry, schema.items as Schema, root, `${at}[${index}]`));
  if (kind !== 'object') return [];
  const object = value as Record<string, unknown>, properties = (schema.properties ?? {}) as Record<string, Schema>;
  const extra = schema.additionalProperties === false ? Object.keys(object).filter(key => !(key in properties)).map(key => `${at}.${key}: unknown field`) : [];
  const missing = ((schema.required ?? []) as string[]).filter(key => !(key in object)).map(key => `${at}.${key}: missing`);
  return [...extra, ...missing, ...Object.entries(object).flatMap(([key, entry]) => properties[key] ? problems(entry, properties[key], root, `${at}.${key}`) : [])];
}
const snapshotSchema = schemaOf('PreferencesSnapshot'), entrySchema = schemaOf('PreferencesPatchEntry');

/** What main (c9a79434) wrote after the owner opened two tabs and went back to the first: every field it knew. */
function savedByMain(transport: AppTransport, selected: PreferencesSnapshot['global']['selected_navigation']): PreferencesSnapshot {
  const first = { ...transport.view(), tab_order: 0, selected_item_id: '1', scroll: { item_id: '1', offset: 40 } };
  const second = { ...transport.view(secondId), tab_order: 1, filters: { ...transport.view().filters, search: 'cache' } };
  return { schema_version: 1, revision: 7, later: [], drafts: [], sessions: [first, second],
    global: { theme: 'dark', selected_navigation: selected, window: null, pinned: false, notification_watermark: null,
      detail_width: 520, waiting_collapsed: true, session_archive_expanded_project_ids: [route.project_id] } };
}
function boot(selected: PreferencesSnapshot['global']['selected_navigation']) {
  const transport = new AppTransport();
  Object.assign(transport.preferences, savedByMain(transport, selected));
  render(<DesktopApp service={createDesktopService(transport)} />);
  return transport;
}
const written = (transport: AppTransport) => transport.mutations.flatMap(request => request.command.command === 'preferences_patch' ? request.command.params.entries : []);
const navigationWrites = (transport: AppTransport) => written(transport).filter((entry): entry is Extract<PreferencesPatchEntry, { kind: 'set_global' }> => entry.kind === 'set_global');
const switcherButton = () => screen.getByRole('button', { name: /^Switch session or project/ });
async function openSwitcher() {
  await waitFor(() => expect(switcherButton().hasAttribute('disabled')).toBe(false));
  fireEvent.click(switcherButton());
  return screen.findByRole('dialog', { name: 'Switch session or project' });
}
async function sessionReady(name: string) {
  await waitFor(() => {
    expect(screen.getByRole('region', { name: 'Session tree' }).getAttribute('data-session-status')).toBe('ready');
    expect(switcherButton().textContent).toContain(name);
  });
}

describe('ui.json saved by main, read and written here', () => {
  it('opens the last active of several open tabs, saves no page, and writes only fields main reads', { timeout: 15_000 }, async () => {
    const transport = boot({ kind: 'session', session: route });
    expect(problems(transport.preferences, snapshotSchema, snapshotSchema)).toEqual([]);
    await sessionReady('Notes review');
    expect(screen.queryByRole('alert')).toBeNull();

    // A page is not saved: the selection stays the session, so a restart (or main) opens it again.
    const before = navigationWrites(transport).length;
    fireEvent.click(within(await openSwitcher()).getByRole('button', { name: 'All sessions' }));
    await screen.findByRole('heading', { name: 'All sessions' });
    expect(navigationWrites(transport)).toHaveLength(before);
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: route });

    // A session is saved the way main saves a tab: selection plus its view with tab_open true.
    fireEvent.click(within(await openSwitcher()).getByRole('option', { name: /Separate session/ }));
    await waitFor(() => expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: { ...route, session_id: secondId } }));
    await screen.findByRole('region', { name: 'Session tree' });
    expect(transport.preferences.sessions.map(view => [view.session.session_id, view.tab_open, view.tab_order])).toEqual(expect.arrayContaining([
      [route.session_id, true, 0], [secondId, true, 1]]));

    // Main's reader: every entry and the resulting file keep to the fields main's DTOs accept.
    for (const entry of written(transport)) expect(problems(entry, entrySchema, entrySchema)).toEqual([]);
    expect(problems(transport.preferences, snapshotSchema, snapshotSchema)).toEqual([]);
    // Fields this build no longer shows are kept for main as they were.
    expect(transport.preferences.global).toMatchObject({ detail_width: 520, waiting_collapsed: true, session_archive_expanded_project_ids: [route.project_id] });
    expect(transport.preferences.sessions.find(view => view.session.session_id === secondId)?.filters.search).toBe('cache');
  });

  it('opens a page main saved as the selection, returning to the newest-opened tab', async () => {
    const transport = boot({ kind: 'all_sessions' });
    await screen.findByRole('heading', { name: 'All sessions' });
    const back = await screen.findByTitle('Back ( esc )');
    expect(back.textContent).toContain('Separate session');
    await act(async () => { fireEvent.click(back); });
    await sessionReady('Separate session');
    expect(transport.preferences.global.selected_navigation).toEqual({ kind: 'session', session: { ...route, session_id: secondId } });
    expect(problems(transport.preferences, snapshotSchema, snapshotSchema)).toEqual([]);
  });

  it('the shape check itself refuses a field main does not know', () => {
    const tampered = structuredClone(savedByMain(new AppTransport(), { kind: 'projects' })) as unknown as { global: Record<string, unknown> };
    tampered.global.current_page = 'archive';
    expect(problems(tampered, snapshotSchema, snapshotSchema)).toEqual(['$.global.current_page: unknown field']);
    expect(problems({ kind: 'set_global', preferences: { ...tampered.global } }, entrySchema, entrySchema)).not.toEqual([]);
  });
});
