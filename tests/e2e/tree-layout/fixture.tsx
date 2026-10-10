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

// The ordinary App over its real stores; only the native transport is replaced.
// Item 1 carries a long finding (it must fold to two lines), item 5 a paragraph that
// wraps over a few lines (hover must not rewrap it), the rest keep their short text.
class TreeLayoutTransport extends AppTransport {
  constructor() {
    super();
    const items = this.sessions.get(route.session_id)!.items;
    items['1']!.question = 'A long item title with enough words to span several lines in a narrow tree. '.repeat(5);
    for (let n = 9; n <= 18; n++) items[String(n)] = { ...items['8']!, id: String(n), ordinal: n, question: `Another item ${n}`, outcome: 'A short result.' };
    items['1']!.outcome = Array.from({ length: 20 }, (_, index) => `Line ${index + 1} of a long finding the agent wrote.`).join('\n');
    items['5']!.outcome = 'A decision paragraph that is long enough to wrap over several lines in the tree column, so that any change in the width of its '
      + 'column on hover would move words from one line to the next and show up as a different line count.';
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
    remember: () => {}, onFocus: () => {}, onKeyDown: () => {}, onSelect: () => setSelected(true), onToggle: () => {}, onJump: () => {}, onHover: () => {} };
  return <>
    {/* 560px is the desktop's minimum centre column, including when both side panels are open. */}
    <div className="tree-column" style={{ width: 'min(560px, 100%)' }}>
      <ItemRow {...props} row={row} selected={selected} actions={actions} />
      <ItemRow {...props} row={{ ...row, key: '2', item: immutable({ ...item, id: '2', ordinal: 2 }) }} selected={false} actions={[]} />
    </div>
    <output aria-label="Last action">{clicked}</output>
  </>;
}

createRoot(document.getElementById('root')!).render(new URLSearchParams(window.location.search).has('grid')
  ? <ActionGridFixture /> : <DesktopApp service={createDesktopService(new TreeLayoutTransport())} />);
