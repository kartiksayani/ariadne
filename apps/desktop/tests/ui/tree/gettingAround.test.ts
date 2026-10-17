import { describe, expect, it } from 'vitest';
import { AppTransport, route } from '../app/transport';
import { branchItems, breadcrumbItems } from '../../../src/ui/tree/gettingAround';
import { shimTree } from './shimTree';
import { workspaceIntent } from '../../../src/ui/keys';

describe('Map getting around selectors', () => {
  it('keeps only the focused root, descendants, and its topic without changing the session', () => {
    const transport = new AppTransport(), session = transport.sessions.get(route.session_id)!;
    const view = transport.preferences.sessions.find(value => value.session.session_id === route.session_id)!;
    const input = { session, view, search: '', later: new Set<string>(), collapsedTopics: new Set<string>(), selectedId: null,
      revealId: null, temporaryExpanded: [], presence: null, summaries: [], now: Date.now() };
    const before = structuredClone(session);
    // The focus is a walk input: the root and its branch stay, the topic's other roots become one strip, other topics go.
    const focused = shimTree({ ...input, focusRootId: '1' }).rows;
    expect(focused.filter(row => row.kind === 'item').map(row => row.key)).toEqual(['1', '1.1']);
    expect(focused.filter(row => row.kind === 'topic').map(row => row.key)).toEqual([session.items['1']!.topic_id]);
    expect(focused.filter(row => row.kind === 'strip').every(row => row.reason === 'focus')).toBe(true);
    expect(branchItems(session, '1')).toEqual(new Set(['1', '1.1']));
    const all = shimTree(input).rows;
    expect(shimTree({ ...input, focusRootId: null }).rows).toEqual(all);
    expect(shimTree({ ...input, focusRootId: 'gone' }).rows).toEqual(all);
    expect(session).toEqual(before);
  });

  it('shows at most three nearest ancestor levels, in reading order, and terminates on a corrupt cycle', () => {
    const session = new AppTransport().sessions.get(route.session_id)!;
    for (let index = 0; index < 5; index++) session.items[`deep-${index}`] = { ...session.items['1']!, id: `deep-${index}`, parent: index ? `deep-${index - 1}` : null };
    expect(breadcrumbItems(session, 'deep-4')).toEqual(['deep-1', 'deep-2', 'deep-3']);
    expect(breadcrumbItems(session, 'deep-0')).toEqual([]);
    session.items['deep-0']!.parent = 'deep-4';
    expect(breadcrumbItems(session, 'deep-4')).toEqual(['deep-1', 'deep-2', 'deep-3']);
    expect(branchItems(session, 'deep-0').size).toBe(5);
  });

  it('maps Space and Cmd+E without taking plain e or Ctrl+E', () => {
    expect(workspaceIntent({ key: ' ' })).toEqual({ kind: 'peek' });
    expect(workspaceIntent({ key: 'e', metaKey: true })).toEqual({ kind: 'recent' });
    // Plain e archived the topic once; SPEC 6.1 leaves it unbound.
    expect(workspaceIntent({ key: 'e' })).toBeNull();
    expect(workspaceIntent({ key: 'e', ctrlKey: true })).toBeNull();
  });
});
