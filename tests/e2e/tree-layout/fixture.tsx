// Base styles first, as in main.tsx.
import '../../../apps/desktop/src/style.css';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { DesktopApp } from '../../../apps/desktop/src/App';
import { createDesktopService } from '../../../apps/desktop/src/data/service';
import { AppTransport, route } from '../../../apps/desktop/tests/ui/app/transport';
import { ItemRow, type RowCommand } from '../../../apps/desktop/src/ui/tree/ItemRow';
import { ackTitle } from '../../../apps/desktop/src/ui/shared/ack';
import { immutable } from '../../../apps/desktop/src/data';
import type { ItemRow as Row } from '../../../apps/desktop/src/ui/tree/model';
import { Shell } from '../../../apps/desktop/src/ui/shell/Shell';
import { DetailsColumn } from '../../../apps/desktop/src/ui/shell/DetailsColumn';
import { DockInsetProvider } from '../../../apps/desktop/src/ui/shell/dockInset';
import { useWorkspaceKeys } from '../../../apps/desktop/src/ui/keys';
import { workspaceKeys } from '../../../apps/desktop/src/ui/shell/workspaceKeys';
import { DetailsColumnProvider } from '../../../apps/desktop/src/state/details/column';
import '../../../apps/desktop/src/ui/detail/detail.css';
import { notices } from '../../../apps/desktop/src/ui/pages/notices';
import { toasts } from '../../../apps/desktop/src/ui/shell/toast';

// The ordinary App over its real stores; only the native transport is replaced.
// Item 1 carries a long finding (it must fold to three lines), item 5 a paragraph that
// wraps over a few lines (hover must not rewrap it), the rest keep their short text.
class TreeLayoutTransport extends AppTransport {
  constructor({ gettingAround = false, changes = false, card = false, still = false, filter = false, continuable = false, many = false } = {}) {
    super();
    const session = this.sessions.get(route.session_id)!;
    // A topic that began here, not one continued from another session: its band draws Continue elsewhere.
    if (continuable) for (const topic of Object.values(session.topics)) if (topic) topic.origin = null;
    if (card) { // An archived session with a long name: the top bar and its connection card must still fit a narrow window.
      session.name = 'A long session name that needs to fit in a narrow window';
      session.state = 'closed'; session.closed_at = session.updated_at; session.archived_at = session.updated_at;
      this.preferences.global.selected_navigation = { kind: 'session', session: route };
    }
    // These tests measure the Map, not the stuck-reply notice (alpha.21 E17): the demo's old queued replies stay "just sent".
    for (const input of Object.values(session.inputs)) if (input) input.created_at = '2099-01-01T00:00:00.000Z';
    const items = session.items;
    items['1']!.question = 'A long item title with enough words to span several lines in a narrow tree. '.repeat(5);
    for (let n = 9; n <= 18; n++) items[String(n)] = { ...items['8']!, id: String(n), ordinal: n, question: `Another item ${n}`, outcome: 'A short result.' };
    // The clamp is three lines and folds only when at least one line would hide: three lines stay open, four fold.
    items['9']!.outcome = Array.from({ length: 3 }, (_, index) => `Body line ${index + 1}`).join('\n');
    items['10']!.outcome = Array.from({ length: 4 }, (_, index) => `Body line ${index + 1}`).join('\n');
    for (const [id, lines, kind] of [[11, 3, 'paragraph'], [12, 4, 'paragraph'], [13, 3, 'list'], [14, 4, 'list'], [15, 3, 'code'], [16, 4, 'code']] as const) {
      const body = Array.from({ length: lines }, (_, index) => `${kind === 'list' ? '- ' : ''}Short line ${index + 1}`);
      items[String(id)]!.outcome = kind === 'code' ? `\`\`\`\n${body.join('\n')}\n\`\`\`` : body.join(kind === 'paragraph' ? '\n\n' : '\n');
    }
    items['17']!.outcome = '[Read the evidence](https://example.com)\n' + Array.from({ length: 3 }, (_, index) => `**Evidence** \`code\` line ${index + 1}`).join('\n');
    items['1']!.outcome = Array.from({ length: 20 }, (_, index) => `Line ${index + 1} of a long finding the agent wrote.`).join('\n');
    items['5']!.outcome = 'A decision paragraph that is long enough to wrap over several lines in the tree column, so that any change in the width of its '
      + 'column on hover would move words from one line to the next and show up as a different line count.';
    // A big session (map-idle.spec.mts): 2,000 more one-line results after item 18, in the same topic, about 2,020 rows.
    if (many) for (let n = 100; n < 2100; n++) items[String(n)] = { ...items['8']!, id: String(n), ordinal: n, question: `Result ${n}`, outcome: 'A short result.' };
    if (gettingAround) {
      items['1']!.question = 'Harbor check'; items['1']!.short = 'Harbor check';
      const names = ['Review scope', 'Rehearsal notes', 'Evidence check', 'Owner handoff', 'Final check'];
      names.forEach((name, index) => {
        const id = String(19 + index);
        items[id] = { ...items['1.1']!, id, ordinal: 19 + index, parent: index ? String(18 + index) : '1',
          question: name, short: name, outcome: Array.from({ length: 6 }, () => 'The agent recorded supporting evidence for this step.').join('\n') };
      });
      const view = this.preferences.sessions.find(value => value.session.session_id === route.session_id)!;
      view.expanded_item_ids.push('19', '20', '21', '22');
      items['4']!.outcome = 'See [the waiting question](item:2).';
    }
    if (changes) {
      const baseline = '2026-10-01T00:00:00.000Z', later = '2026-10-13T09:00:00.000Z';
      Object.values(items).forEach(item => { if (item) { item.created_at = baseline; item.changes = []; } });
      items['1.1']!.created_at = later;
      items['18']!.created_at = later;
      items['2']!.revision = 2;
      items['2']!.changes = [{ revision: 2, at: later, cause_message_id: items['2']!.created_message_id, before: { status: 'open' } }];
      items['3']!.changes = [{ revision: 2, at: later, wording_only: true, cause_message_id: items['3']!.created_message_id, before: { question: 'Original wording' } }];
      this.preferences.seen = [{ session: route, since: baseline, items: [], topics: [] }];
      this.preferences.sessions[0]!.expanded_item_ids = [];
    }
    if (still || filter) {
      // The Map-still table (map-still.spec.mts): 1.1 folds inside item 1, 11 is New, 12 Changed and waits for an Ack.
      const baseline = '2026-10-01T00:00:00.000Z', later = '2026-10-13T09:00:00.000Z';
      Object.values(items).forEach(item => { if (item) { item.created_at = baseline; item.changes = []; } });
      items['11']!.created_at = later;
      items['12']!.revision = 2;
      items['12']!.changes = [{ revision: 2, at: later, cause_message_id: items['12']!.created_message_id, before: { status: 'in_progress' } }];
      items['12']!.type = 'finding'; items['12']!.ack_to = 'done'; items['12']!.ask = null;
      // 13 is a question waiting on the owner: it carries the "Session closed" chip when the session ends.
      Object.assign(items['13']!, { status: 'waiting_on_me', type: items['2']!.type, ask: items['2']!.ask, ack_to: null });
      // The agent removed an item from this topic: its bin (the "…" menu's Open the bin) holds it.
      items['41'] = { ...items['18']!, id: '41', ordinal: 41, question: 'Removed by the agent', removed_at: later };
      // No reply to a whole topic is on its way, so the "…" menu's Reply to topic is open to press.
      for (const input of Object.values(session.inputs)) if (input && input.target.item_id === null && !['handled', 'cancelled', 'skipped'].includes(input.state)) input.state = 'handled';
      this.preferences.seen = [{ session: route, since: baseline, items: [], topics: [] }];
      this.preferences.sessions[0]!.expanded_item_ids = ['2', '3'];
    }
    if (filter) {
      // The filter-row table (map-still.spec.mts): every chip's list scrolls. Items 19-38 join 9-18 as one-line results.
      // To ack: 12 and 19-38. Blocked: 9-37 wait on item 8, which stays open; 38 waits on item 2, which an agent can settle.
      for (let n = 19; n <= 38; n++) {
        items[String(n)] = { ...items['8']!, id: String(n), ordinal: n, question: `Another item ${n}`, outcome: 'A short result.',
          type: 'finding', ack_to: 'done', ask: null };
      }
      for (let n = 9; n <= 37; n++) items[String(n)]!.depends_on = ['8'];
      items['38']!.depends_on = ['2'];
    }
  }
  /** Set by a spec: every Ack is refused, so an Ack all batch stops in its failed state ("0 saved · N to finish"). */
  failAck = false;
  /** Set while a read of the session fails, as a locked or damaged session file does: the Map keeps its last good copy. */
  failReads = false;
  /** While above 0, every read of the session takes this many ms to answer, as a 2,000-item session on a busy machine does. */
  holdReads = 0;
  /** Session reads held by `holdReads` that have not answered yet: a spec asserts a read is still pending with it. */
  heldReads = 0;
  /** While set, a preferences save waits here: it is in flight, and its outcome is not known yet. */
  private saveGate: Promise<void> | null = null;
  /** Set until the owner's next "Later" is saved: that write is lost on its way back (reading marks and the like still land). */
  private loseLater = false;
  private releaseSave = () => {};
  /** The owner's Ack lands: the proposal is accepted, so the item takes its target status and leaves "to ack". */
  async invoke<T>(name: string, args: Parameters<AppTransport['invoke']>[1]): Promise<T> {
    const { request } = args;
    if (this.failReads && !('command' in request) && request.request.command === 'session_get') throw new Error('The session file could not be read.');
    if (this.holdReads && !('command' in request) && request.request.command === 'session_get') {
      ++this.heldReads;
      try { await new Promise(resolve => setTimeout(resolve, this.holdReads)); } finally { --this.heldReads; }
    }
    if ('command' in request && request.command.command === 'preferences_patch' && this.saveGate) await this.saveGate;
    if ('command' in request && request.command.command === 'preferences_patch' && this.loseLater
        && request.command.params.entries.some(entry => entry.kind === 'set_later')) { this.loseLater = false; throw new Error('Lost response'); }
    if ('command' in request && request.command.command === 'ack') {
      if (this.failAck) throw new Error('The Ack could not be saved.');
      const session = this.sessions.get(request.session!.session_id)!, item = session.items[request.command.params.item_id]!;
      item.status = item.ack_to!; item.ack_to = null; ++item.revision; ++session.revision;
      this.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision });
      return { api_version: 1, ok: true, data: { operation_id: request.command.op_id, session_id: session.id, revision: session.revision,
        data: { kind: 'item_ack', item_id: item.id, item_revision: item.revision, status: item.status, message_id: crypto.randomUUID() } } } as T;
    }
    // The owner archives a topic (E33): it is marked archived and leaves one strip in its place for this visit.
    if ('command' in request && request.command.command === 'topic_archive') {
      const session = this.sessions.get(request.session!.session_id)!, topic = session.topics[request.command.params.topic_id]!;
      topic.archived_at = session.updated_at; ++topic.revision; ++session.revision;
      this.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision });
      return { api_version: 1, ok: true, data: { operation_id: request.command.op_id, session_id: session.id, revision: session.revision,
        data: { kind: 'topic_lifecycle', topic_id: topic.id, topic_revision: topic.revision, archived_at: topic.archived_at } } } as T;
    }
    const result = await super.invoke<T>(name, args);
    // The session list names the host's latest report for the active binding, as the real list does. The store re-reads it every
    // poll (2 s) and lets it replace its live presence, so a list that still told the opening report ("connected") would undo a
    // reported drop within a poll, and a poll already in flight when the drop came would undo it before the spec could look.
    if (!('command' in request) && request.request.command === 'session_list') {
      for (const summary of (result as { data: { data: { sessions: { items: { active_binding: { id: string; presence: unknown } | null }[] } } } }).data.data.sessions.items) {
        const report = summary.active_binding && this.hostReports.get(summary.active_binding.id);
        if (report) summary.active_binding!.presence = structuredClone(report);
      }
    }
    return result;
  }
  /** The latest presence report per binding, as the host last sent it (see `agent`). */
  private readonly hostReports = new Map<string, unknown>();
  /** What the agent writes while the owner reads: the session's next revision, announced as the desktop does. */
  agent(change: string) {
    const session = this.sessions.get(route.session_id)!, items = session.items;
    if (change === 'add-above') items['3.1'] = { ...items['1.1']!, id: '3.1', parent: '3', ordinal: 40, question: 'A new finding above the reading row' };
    if (change === 'add-below') items['40'] = { ...items['18']!, id: '40', ordinal: 40, question: 'A new item at the end' };
    if (change === 'ack-lands') { items['12']!.status = 'done'; items['12']!.ack_to = null; ++items['12']!.revision; }
    // A result above the reading row arrives with an Ack to give: its row takes the wider Ack slot and may rewrap.
    if (change === 'ack-gains-above') { Object.assign(items['9']!, { type: 'finding', ack_to: 'done', ask: null }); ++items['9']!.revision; }
    if (change === 'counts') { items['15']!.status = 'in_progress'; ++items['15']!.revision; }
    // The agent renames an item above the reading row to a much longer name: it wraps to more lines.
    if (change === 'grow-above') { items['9']!.question = 'Another item 9, renamed to a much longer name that wraps over several lines in the Map. '.repeat(3); ++items['9']!.revision; }
    if (change === 'session-ends') { session.state = 'closed'; session.closed_at = session.updated_at; }
    // The connection lines above the Map (SPEC 12.3, 12.6, 12.8): the agent stops and returns, the connection drops, a read fails
    // (the Map keeps its last good copy) and comes back.
    const binding = session.bindings[session.active_binding_id!]!;
    if (change === 'agent-stops') { binding.connection_state = 'disconnected'; binding.dispatch_state = 'disconnected'; }
    // The host's own report outranks the stored state, so the drop and the return are reported as the host would.
    const reported = (connection_state: 'connected' | 'reconnecting', instance_id: string = crypto.randomUUID()) => {
      const observation = { instance_id, generation: binding.generation, connection_state, execution_state: 'idle', last_seen_at: new Date().toISOString(),
        source: 'bridge_heartbeat', process_identity: null, freshness: 'fresh' } as never;
      this.hostReports.set(binding.id, observation);
      this.emit('ariadne://presence_changed', { binding_id: binding.id, generation: binding.generation, observation });
    };
    if (change === 'connection-drops') { binding.connection_state = 'reconnecting'; reported('reconnecting'); return; }
    if (change === 'agent-returns') { binding.connection_state = 'connected'; binding.dispatch_state = 'enabled'; reported('connected'); }
    // The host's heartbeat while the agent is quiet: the same running instance, seen again now. Nothing on the Map changes.
    if (change === 'heartbeat') { reported('connected', '00000000-0000-4000-8000-0000000000ab'); return; }
    if (change === 'read-fails') { this.failReads = true; this.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision + 1 }); return; }
    if (change === 'read-returns') this.failReads = false;
    // A hint arrives and the read it starts takes 6 s (a row click and Send must not wait for it); 'read-release' ends the hold.
    if (change === 'read-hold') { this.holdReads = 6000; this.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision + 1 }); return; }
    if (change === 'read-release') { this.holdReads = 0; return; }
    // SPEC 12.9: the next save is lost on its way back (Ariadne can't tell whether it landed); its check can be held in flight and released.
    if (change === 'save-unsure') { this.loseLater = true; return; }
    if (change === 'save-hold') { this.saveGate = new Promise<void>(resolve => { this.releaseSave = resolve; }); return; }
    if (change === 'save-release') { this.saveGate = null; this.releaseSave(); return; }
    // The dependency of the last Blocked item is done: it leaves the Blocked filter by itself.
    if (change === 'settle') { items['2']!.status = 'done'; ++items['2']!.revision; }
    // An Ack landing from elsewhere (the Graph has no Ack button): the item takes its target status and is no longer to ack.
    if (change.startsWith('ack:')) { const item = items[change.slice(4)]!; item.status = item.ack_to ?? item.status; item.ack_to = null; ++item.revision; }
    // The hold at every scroll position (D24): a first row above everything, and a named row leaving or removed.
    if (change === 'add-top') items['0'] = { ...items['1.1']!, id: '0', parent: null, ordinal: 0, question: 'A new item at the very top' };
    const [verb, id] = change.split(':');
    if (verb === 'leave' && id) { items[id]!.status = 'in_progress'; ++items[id]!.revision; }
    if (verb === 'grow' && id) { items[id]!.question = 'A longer title the agent rewrote, wrapping over a few lines of the Map. '.repeat(4); ++items[id]!.revision; }
    // The row's title is back to its one line: a row above the reading row shrinks.
    if (verb === 'shrink' && id) { items[id]!.question = `Another item ${id}`; ++items[id]!.revision; }
    if (verb === 'remove' && id) { items[id]!.removed_at = session.updated_at; ++items[id]!.revision; }
    // The agent writes more on a row: its result runs six lines longer.
    if (verb === 'write' && id) { items[id]!.outcome += '\n' + Array.from({ length: 6 }, (_, index) => `More line ${index + 1}`).join('\n'); ++items[id]!.revision; }
    ++session.revision;
    this.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision });
  }
  /** A newer revision is announced but the read still returns this one: the "out of date" notice opens above the Map. */
  stale() {
    const session = this.sessions.get(route.session_id)!;
    this.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision + 1 });
  }
  /** A saved status filter lands, as the desktop's other window or a restore writes it. */
  filter(statuses: string[]) {
    this.preferences.sessions.find(value => value.session.session_id === route.session_id)!.filters.statuses = statuses as never;
    ++this.preferences.revision;
    this.emit('ariadne://preferences_changed', { revision: this.preferences.revision });
  }
  /** The owner's reading of an item lands from elsewhere (the dock or Details' 1 s dwell): its marker clears. */
  seen(itemId: string) {
    const entry = this.preferences.seen!.find(value => value.session.session_id === route.session_id)!;
    entry.items.push({ item_id: itemId, revision: this.sessions.get(route.session_id)!.items[itemId]!.revision });
    ++this.preferences.revision;
    this.emit('ariadne://preferences_changed', { revision: this.preferences.revision });
  }
}
/** All available actions together, including combinations that normal statuses split across rows. */
function ActionGridFixture() {
  const [selected, setSelected] = useState(false), [clicked, setClicked] = useState('');
  const item = new TreeLayoutTransport().sessions.get(route.session_id)!.items['1']!;
  item.status = 'open';
  const row: Row = { kind: 'item', key: item.id, item: immutable(item), status: 'open', ack: 'in_progress', depth: 1,
    hasKids: false, expanded: false, context: false, guides: [], later: false, hidden: false,
    segments: [{ text: item.question, hit: false }], matches: [], replacedBy: null, relatedCount: 0,
    collapsed: null, delivery: null, badge: 'Open', branch: 0, boxes: [] };
  // The hover bar's six slots in SPEC 6.2's order, then Ack in its own persistent slot: an open item with an Ack to In progress.
  const titles: Record<RowCommand, string> = { ack: ackTitle('in_progress', 'open'), reply: 'Reply (r)', bring: 'Bring it up (b)', later: 'Later (z)', drop: 'Drop (d)',
    hide: 'Hide (x)', remove: 'Remove (⌫)', followup: 'Follow up (r)', note: 'Add a note (r)', reopen: 'Back to Open (o)' };
  const props = { focused: false, note: null, unfolded: false, onUnfold: () => {}, stopped: null, ackDisabled: false,
    run: (command: RowCommand) => setClicked(titles[command]),
    remember: () => {}, onFocus: () => {}, onKeyDown: () => {}, onSelect: () => setSelected(true), onToggle: () => {} };
  return <>
    {/* 560px is the desktop's minimum centre column, including when both side panels are open. */}
    <div className="tree-column" style={{ width: 'min(560px, 100%)', containerName: 'tree-map', containerType: 'inline-size' }}>
      <ItemRow {...props} row={row} selected={selected} />
      <ItemRow {...props} row={{ ...row, key: '2', ack: null, item: immutable({ ...item, id: '2', ordinal: 2 }) }} selected={false} />
    </div>
    <output aria-label="Last action">{clicked}</output>
  </>;
}

/**
 * The Details column in the real shell, under a stand-in dock of the height in the query (`?details&dock=200`): a long
 * conversation that scrolls above a pinned composer, as the item detail lays them out.
 */
function DetailsFixture({ dock, bigger }: { dock: number; bigger: boolean }) {
  const messages = Array.from({ length: 40 }, (_, index) => <p key={index} className="fixture-message">Message {index + 1} in a long conversation.</p>);
  // The App root's own key handler, so ⌥↑ / ⌥↓ scroll these panels the way they do in the app (details-keys.spec.mts).
  const keys = useWorkspaceKeys<HTMLDivElement>(workspaceKeys({ focused: () => null, focusOwner: () => {}, quickAnswer: () => false, closeDetail: () => {}, onPage: false }), { scope: 'workspace' });
  return <DockInsetProvider height={dock}><DetailsColumnProvider saved={null}><div style={{ display: 'contents' }} onKeyDown={keys}>
    <Shell topBar={<div style={{ height: 40 }} />} main={<button type="button">Map</button>}
      legacy={{ conversation: bigger ? <div className="item-conversation" data-testid="bigger-view" tabIndex={-1} style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
        <div className="detail-body" data-testid="detail-body" style={{ flex: 1, minHeight: 0 }}>{messages}</div>
        <div className="detail-dock" data-testid="bigger-composer"><textarea aria-label="Reply in the bigger view" rows={2} /></div></div> : undefined }}
      side={<DetailsColumn path={<span>Topic / item</span>} rail={<i className="ph ph-check-circle" />}>
        <div className="item-detail"><div className="detail-body" data-testid="detail-body">{messages}</div>
          <div className="detail-dock"><textarea aria-label="Reply" rows={2} /><button type="button">Send</button></div></div>
      </DetailsColumn>}
      dock={dock ? <div data-testid="dock" style={{ height: dock, background: 'rgb(200 60 60 / 85%)' }} /> : undefined} />
  </div></DetailsColumnProvider></DockInsetProvider>;
}

const query = new URLSearchParams(window.location.search);
const transport = new TreeLayoutTransport({ gettingAround: query.has('nav'), changes: query.has('changes'), card: query.has('card'), still: query.has('still'), filter: query.has('filter'), continuable: query.has('continuable'), many: query.has('many') });
// The specs drive agent writes and seen marks through this handle.
(window as unknown as { treeLayout: TreeLayoutTransport }).treeLayout = transport;
// The notice stack and the toast, which the Map must never move for (notices-still.spec.mts).
(window as unknown as { floating: { notices: typeof notices; toasts: typeof toasts } }).floating = { notices, toasts };
createRoot(document.getElementById('root')!).render(query.has('details') ? <DetailsFixture dock={Number(query.get('dock') ?? 0)} bigger={query.has('bigger')} />
  : query.has('grid') ? <ActionGridFixture />
  : <DesktopApp service={createDesktopService(transport)} />);
