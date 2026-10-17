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
// Item 1 carries a long finding (it must fold to four lines), item 5 a paragraph that
// wraps over a few lines (hover must not rewrap it), the rest keep their short text.
class TreeLayoutTransport extends AppTransport {
  constructor({ gettingAround = false, changes = false } = {}) {
    super();
    const items = this.sessions.get(route.session_id)!.items;
    items['1']!.question = 'A long item title with enough words to span several lines in a narrow tree. '.repeat(5);
    for (let n = 9; n <= 18; n++) items[String(n)] = { ...items['8']!, id: String(n), ordinal: n, question: `Another item ${n}`, outcome: 'A short result.' };
    items['9']!.outcome = Array.from({ length: 6 }, (_, index) => `Body line ${index + 1}`).join('\n');
    items['10']!.outcome = Array.from({ length: 7 }, (_, index) => `Body line ${index + 1}`).join('\n');
    for (const [id, lines, kind] of [[11, 6, 'paragraph'], [12, 7, 'paragraph'], [13, 6, 'list'], [14, 7, 'list'], [15, 6, 'code'], [16, 7, 'code']] as const) {
      const body = Array.from({ length: lines }, (_, index) => `${kind === 'list' ? '- ' : ''}Short line ${index + 1}`);
      items[String(id)]!.outcome = kind === 'code' ? `\`\`\`\n${body.join('\n')}\n\`\`\`` : body.join(kind === 'paragraph' ? '\n\n' : '\n');
    }
    items['17']!.outcome = '[Read the evidence](https://example.com)\n' + Array.from({ length: 6 }, (_, index) => `**Evidence** \`code\` line ${index + 1}`).join('\n');
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
  }
}
/** All available actions together, including combinations that normal statuses split across rows. */
function ActionGridFixture() {
  const [selected, setSelected] = useState(false), [clicked, setClicked] = useState('');
  const item = new TreeLayoutTransport().sessions.get(route.session_id)!.items['1']!;
  item.status = 'open';
  const row: Row = { kind: 'item', key: item.id, item: immutable(item), status: 'open', ack: null, depth: 1,
    hasKids: false, expanded: false, context: false, guides: [], later: false, hidden: false,
    segments: [{ text: item.question, hit: false }], replacedBy: null, rounds: 0, relatedCount: 0,
    collapsed: null, delivery: null, badge: 'Open' };
  const definitions = [
    { icon: 'ph ph-check', title: 'Ack → Decided', label: 'Ack', persistent: true },
    { icon: 'ph ph-megaphone-simple', title: 'Bring it up (b)' }, { icon: 'ph ph-chat-text', title: 'Reply (r)' },
    { icon: 'ph ph-x-circle', title: 'Drop (d)' }, { icon: 'ph ph-clock', title: 'Later (z)' },
    { icon: 'ph ph-arrow-counter-clockwise', title: 'Back to Open (o)' }, { icon: 'ph ph-eye-slash', title: 'Hide (x)' },
    { icon: 'ph ph-trash', title: 'Remove (⌫)' },
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
createRoot(document.getElementById('root')!).render(query.has('details') ? <DetailsFixture dock={Number(query.get('dock') ?? 0)} bigger={query.has('bigger')} />
  : query.has('grid') ? <ActionGridFixture /> : query.has('bar')
  // The session bar is gone with the tabs (alpha.19 navigation); its menu moved to the top bar's connection card. The
  // e2e migrator moves `?bar` and its test onto the card.
  ? <p>The session bar was removed; this fixture awaits its connection-card replacement.</p> : <DesktopApp service={createDesktopService(new TreeLayoutTransport({ gettingAround: query.has('nav'), changes: query.has('changes') }))} />);
