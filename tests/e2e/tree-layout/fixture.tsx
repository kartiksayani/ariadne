// Base styles first, as in main.tsx.
import '../../../apps/desktop/src/style.css';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { DesktopApp } from '../../../apps/desktop/src/App';
import { createDesktopService } from '../../../apps/desktop/src/data/service';
import { AppTransport, route } from '../../../apps/desktop/tests/ui/app/transport';
import { ItemRow, type RowAction } from '../../../apps/desktop/src/ui/tree/ItemRow';
import { immutable } from '../../../apps/desktop/src/data';
import type { ItemRow as Row } from '../../../apps/desktop/src/ui/tree/model';
import { Shell } from '../../../apps/desktop/src/ui/shell/Shell';
import { DetailsColumn } from '../../../apps/desktop/src/ui/shell/DetailsColumn';
import { DockInsetProvider } from '../../../apps/desktop/src/ui/shell/dockInset';
import { DetailsColumnProvider } from '../../../apps/desktop/src/state/details/column';
import '../../../apps/desktop/src/ui/detail/detail.css';

// The ordinary App over its real stores; only the native transport is replaced.
// Item 1 carries a long finding (it must fold to three lines), item 5 a paragraph that
// wraps over a few lines (hover must not rewrap it), the rest keep their short text.
class TreeLayoutTransport extends AppTransport {
  constructor({ gettingAround = false, changes = false, card = false, still = false, filter = false } = {}) {
    super();
    const session = this.sessions.get(route.session_id)!;
    if (card) { // An archived session with a long name: the top bar and its connection card must still fit a narrow window.
      session.name = 'A long session name that needs to fit in a narrow window';
      session.state = 'closed'; session.closed_at = session.updated_at; session.archived_at = session.updated_at;
      this.preferences.global.selected_navigation = { kind: 'session', session: route };
    }
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
  /** The owner's Ack lands: the proposal is accepted, so the item takes its target status and leaves "to ack". */
  async invoke<T>(name: string, args: Parameters<AppTransport['invoke']>[1]): Promise<T> {
    const { request } = args;
    if ('command' in request && request.command.command === 'ack') {
      const session = this.sessions.get(request.session!.session_id)!, item = session.items[request.command.params.item_id]!;
      item.status = item.ack_to!; item.ack_to = null; ++item.revision; ++session.revision;
      this.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision });
      return { api_version: 1, ok: true, data: { operation_id: request.command.op_id, session_id: session.id, revision: session.revision,
        data: { kind: 'item_ack', item_id: item.id, item_revision: item.revision, status: item.status, message_id: crypto.randomUUID() } } } as T;
    }
    return super.invoke<T>(name, args);
  }
  /** What the agent writes while the owner reads: the session's next revision, announced as the desktop does. */
  agent(change: string) {
    const session = this.sessions.get(route.session_id)!, items = session.items;
    if (change === 'add-above') items['3.1'] = { ...items['1.1']!, id: '3.1', parent: '3', ordinal: 40, question: 'A new finding above the reading row' };
    if (change === 'add-below') items['40'] = { ...items['18']!, id: '40', ordinal: 40, question: 'A new item at the end' };
    if (change === 'ack-lands') { items['12']!.status = 'done'; items['12']!.ack_to = null; ++items['12']!.revision; }
    if (change === 'counts') { items['15']!.status = 'in_progress'; ++items['15']!.revision; }
    // The agent renames an item above the reading row to a much longer name: it wraps to more lines.
    if (change === 'grow-above') { items['9']!.question = 'Another item 9, renamed to a much longer name that wraps over several lines in the Map. '.repeat(3); ++items['9']!.revision; }
    if (change === 'session-ends') { session.state = 'closed'; session.closed_at = session.updated_at; }
    // The dependency of the last Blocked item is done: it leaves the Blocked filter by itself.
    if (change === 'settle') { items['2']!.status = 'done'; ++items['2']!.revision; }
    // An Ack landing from elsewhere (the Graph has no Ack button): the item takes its target status and is no longer to ack.
    if (change.startsWith('ack:')) { const item = items[change.slice(4)]!; item.status = item.ack_to ?? item.status; item.ack_to = null; ++item.revision; }
    ++session.revision;
    this.emit('ariadne://session_changed', { session_id: session.id, revision: session.revision });
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
  const row: Row = { kind: 'item', key: item.id, item: immutable(item), status: 'open', ack: null, depth: 1,
    hasKids: false, expanded: false, context: false, guides: [], later: false, hidden: false,
    segments: [{ text: item.question, hit: false }], matches: [], replacedBy: null, relatedCount: 0,
    collapsed: null, delivery: null, badge: 'Open', branch: 0, boxes: [] };
  // The hover bar's six slots in SPEC 6.2's order, then Ack in its own persistent slot.
  const definitions = [
    { icon: 'ph ph-check', title: 'Ack → Decided', label: 'Ack', persistent: true },
    { icon: 'ph ph-chat-text', title: 'Reply (r)' }, { icon: 'ph ph-megaphone-simple', title: 'Bring it up (b)' },
    { icon: 'ph ph-clock', title: 'Later (z)' }, { icon: 'ph ph-x-circle', title: 'Drop (d)' },
    { icon: 'ph ph-eye-slash', title: 'Hide (h)' }, { icon: 'ph ph-trash', title: 'Remove (⌫)' },
  ];
  const actions: RowAction[] = definitions.map(action => ({ ...action, run: () => setClicked(action.title) }));
  const props = { focused: false, highlight: null, note: null, answer: null, unfolded: false, onUnfold: () => {},
    remember: () => {}, onFocus: () => {}, onKeyDown: () => {}, onSelect: () => setSelected(true), onToggle: () => {}, onHover: () => {} };
  return <>
    {/* 560px is the desktop's minimum centre column, including when both side panels are open. */}
    <div className="tree-column" style={{ width: 'min(560px, 100%)' }}>
      <ItemRow {...props} row={row} selected={selected} actions={actions} />
      <ItemRow {...props} row={{ ...row, key: '2', item: immutable({ ...item, id: '2', ordinal: 2 }) }} selected={false} actions={[]} />
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
  return <DockInsetProvider height={dock}><DetailsColumnProvider saved={null}>
    <Shell topBar={<div style={{ height: 40 }} />} main={<p>Map</p>}
      legacy={{ conversation: bigger ? <div className="item-conversation" style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
        <div className="detail-body" style={{ flex: 1, minHeight: 0 }}>{messages}</div>
        <div className="detail-dock" data-testid="bigger-composer"><textarea aria-label="Reply in the bigger view" rows={2} /></div></div> : undefined }}
      side={<DetailsColumn path={<span>Topic / item</span>} rail={<i className="ph ph-check-circle" />}>
        <div className="item-detail"><div className="detail-body">{messages}</div>
          <div className="detail-dock"><textarea aria-label="Reply" rows={2} /><button type="button">Send</button></div></div>
      </DetailsColumn>}
      dock={dock ? <div data-testid="dock" style={{ height: dock, background: 'rgb(200 60 60 / 85%)' }} /> : undefined} />
  </DetailsColumnProvider></DockInsetProvider>;
}

const query = new URLSearchParams(window.location.search);
const transport = new TreeLayoutTransport({ gettingAround: query.has('nav'), changes: query.has('changes'), card: query.has('card'), still: query.has('still'), filter: query.has('filter') });
// The specs drive agent writes and seen marks through this handle.
(window as unknown as { treeLayout: TreeLayoutTransport }).treeLayout = transport;
createRoot(document.getElementById('root')!).render(query.has('details') ? <DetailsFixture dock={Number(query.get('dock') ?? 0)} bigger={query.has('bigger')} />
  : query.has('grid') ? <ActionGridFixture />
  : <DesktopApp service={createDesktopService(transport)} />);
