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
import { SessionBar } from '../../../apps/desktop/src/ui/tree/SessionBar';

// The ordinary App over its real stores; only the native transport is replaced.
// Item 1 carries a long finding (it must fold to four lines), item 5 a paragraph that
// wraps over a few lines (hover must not rewrap it), the rest keep their short text.
class TreeLayoutTransport extends AppTransport {
  constructor(gettingAround = false) {
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

const query = new URLSearchParams(window.location.search);
createRoot(document.getElementById('root')!).render(query.has('grid') ? <ActionGridFixture /> : query.has('bar')
  ? <div className="tree-column" style={{ width: 220 }}><SessionBar busy={false} onClose={() => {}} bar={{
    sessionId: route.session_id, title: 'A long session name that needs to fit in a narrow column', secondary: null,
    description: null, named: true, agent: 'codex', where: 'iTerm', meta: '12 topics', running: false,
    connection: 'not_running', closed: true, archived: true,
  }} /></div> : <DesktopApp service={createDesktopService(new TreeLayoutTransport(query.has('nav')))} />);
