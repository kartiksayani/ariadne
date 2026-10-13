import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { handoffMembers } from '../design/source.mts';
import { gettingAroundChrome, gettingAroundItemChrome } from '../design/getting-around-chrome';

interface ProtoItem { id: string; parent: string | null; topic: string; short: string; q: string; type: string; status: string; ack_to?: string; ask?: string }
interface Values {
  showGettingAround?: boolean;
  showMapAncestors?: boolean;
  showRootFocus?: boolean;
  mapTrail: { name: string; question: string; action: string; separator: boolean }[];
  mapNextName: string;
  hasMapNext: boolean;
  mapAncestors: { name: string; separator: boolean }[];
  rows: { isTopic: boolean; topic: { id: string }; ackCount: number; hasAckAll: boolean; canFocus?: boolean; item?: ProtoItem }[];
}
interface Logic {
  state: { items: ProtoItem[]; view: string; subs: Record<string, { stage: string; choice?: number; text?: string; label?: string }>;
    mapAncestorIds?: string[]; mapRecent?: { id: string; action: string }[] };
  scrollRef: { current: unknown };
  rememberMapAncestors: () => void;
  select(id: string, openDetail?: boolean): void;
  renderVals(): Values;
}

/** Run the actual adapted reference logic; React and DC's state shell are the only stand-ins. */
function logic(source: string, props: Record<string, unknown>): Logic {
  const script = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].find(value => value[1]!.includes('class Component extends DCLogic'))![1]!;
  class DCLogic {
    state: Record<string, unknown> = {};
    constructor(readonly props: Record<string, unknown>) {}
    setState(next: Record<string, unknown> | ((state: Record<string, unknown>) => Record<string, unknown>)) {
      Object.assign(this.state, typeof next === 'function' ? next(this.state) : next);
    }
  }
  const Component = runInNewContext(`${script}\nComponent`, { DCLogic, React: { createRef: () => ({ current: null }), createElement: () => null },
    setTimeout: () => 0, clearTimeout: () => {}, document, structuredClone }) as new (props: Record<string, unknown>) => Logic;
  return new Component(props);
}

describe('owner-approved M1 reference navigation chrome', () => {
  const members = handoffMembers(), source = members['Ariadne.dc.html']!, itemSource = members['Item Row.dc.html']!;

  it('reserves the trail and ancestor slots in their correct position without changing comparison limits', () => {
    expect(source.indexOf('data-map-recent')).toBeLessThan(source.indexOf('display:{{ filterDisplay }}'));
    expect(source.indexOf('aria-label="Map ancestors"')).toBeLessThan(source.indexOf('ref="{{ scrollRef }}"'));
    expect(source).toContain('padding:4px 16px 0;');
    expect(source).toContain('box-sizing:border-box; height:28px;');
    expect(source).toContain('height:28px; min-width:0; padding:0 16px;');
    expect(source).toContain('flex-wrap:nowrap; gap:6px; min-width:0; overflow:hidden;');
    expect(source).toContain('max-width:24ch;'); expect(source).toContain('max-width:28ch;');
    expect(source).toContain('title="Recent (⌘E)"');
  });

  it('restores selection with an empty trail and derives the oldest waiting name from session data', () => {
    const reference = logic(source, { selected: '1.3.1.2', detail: true }), values = reference.renderVals();
    expect(values.showGettingAround).toBe(true);
    expect(values.mapTrail).toEqual([]);
    expect(values.hasMapNext).toBe(true); expect(values.mapNextName).toBe('duplicate sub-agent rule');
    expect(source).toContain('<small>· {{ v.action }}</small>');
  });

  it('shows three distinct deliberate visits with current names and keeps the fifteen-entry history', () => {
    const reference = logic(source, { selected: '1.3.1.2', detail: true });
    for (const id of ['1.1', '1.2', '1.3', '1.3.1.2', '1.2']) reference.select(id);
    expect(reference.state.mapRecent?.map(entry => entry.id)).toEqual(['1.2', '1.3.1.2', '1.3', '1.1']);
    reference.state.items.find(item => item.id === '1.2')!.short = 'Renamed result';
    const trail = reference.renderVals().mapTrail;
    expect(trail).toHaveLength(3);
    expect(trail[0]).toMatchObject({ name: 'Renamed result', action: 'viewed', separator: false });
    expect(trail[1]).toMatchObject({ name: 'workspace Redis reads', separator: true });
    reference.select('t1');
    expect(reference.renderVals().mapTrail).toEqual(trail);
    reference.state.mapRecent = Array.from({ length: 15 }, (_, index) => ({ id: `old-${index}`, action: 'peeked' }));
    reference.select('1.1');
    expect(reference.state.mapRecent).toHaveLength(15);
    expect(reference.renderVals().mapTrail).toHaveLength(1);
  });

  it('adapts the existing Text size control so search has the same header space', () => {
    expect(source).toContain('aria-label="Text size"');
    expect(source).toContain('style="width:32px; height:32px; flex:none;">Aa</button>');
    expect(source).not.toContain('title="Messages (m)"');
    expect(source.indexOf('value="{{ q }}"')).toBeGreaterThanOrEqual(0);
    expect(source.indexOf('value="{{ q }}"')).toBeLessThan(source.indexOf('aria-label="Text size"'));
    expect(source.indexOf('aria-label="Text size"')).toBeLessThan(source.indexOf('onClick="{{ toggleTheme }}"'));
  });

  it('keeps the new trail out of graphs and catalogue/archive pages, while reserving empty session chrome', () => {
    for (const props of [{ view: 'graph' }, { scenario: 'archive' }, { scenario: 'projects' }, { scenario: 'sessions' }]) {
      expect(logic(source, props).renderVals().showGettingAround).toBe(false);
    }
    const empty = logic(source, { state: 'empty' }).renderVals();
    expect(empty.showGettingAround).toBe(true); expect(empty.mapTrail).toEqual([]); expect(empty.hasMapNext).toBe(false);
    const loading = logic(source, { state: 'loading' }).renderVals();
    expect(loading.showGettingAround).toBe(false); expect(loading.showMapAncestors).toBe(true);
  });

  it('Next skips already sent replies and never chooses another session’s question', () => {
    const sent = logic(source, {});
    sent.state.subs['3.1'] = { stage: 'received', choice: 0, text: '', label: 'Yes, keep it only in AGENTS.md' };
    expect(sent.renderVals().mapNextName).toBe('default plans in the service');
    const earlier = logic(source, { scenario: 'project', selected: '5.3' }).renderVals();
    expect(earlier.mapNextName).toBe('remove the fallback read');
  });

  it('shows root Focus only for main-map root rows and retains the 24px action height', () => {
    expect(itemSource).toContain('height:24px; min-width:0; padding:2px 5px;');
    expect(itemSource).toContain('aria-label="Focus"');
    expect(itemSource.indexOf('value="{{ lineOutcome }}"')).toBeLessThan(itemSource.indexOf('aria-label="Focus"'));
    expect(itemSource.indexOf('aria-label="Focus"')).toBeLessThan(itemSource.indexOf('value="{{ showCollapsed }}"'));
    const values = logic(source, { selected: '1.3.1' }).renderVals();
    const root = values.rows.find(row => row.item?.id === '1.3')!;
    const child = values.rows.find(row => row.item?.id === '1.3.1')!;
    expect(root.canFocus).toBe(true); expect(child.canFocus).toBe(false);
    expect(logic(itemSource, { row: { ...root, item: root.item } }).renderVals().showRootFocus).toBe(true);
    expect(logic(itemSource, { row: { ...child, item: child.item } }).renderVals().showRootFocus).toBe(false);
    expect(logic(itemSource, { row: { item: root.item } }).renderVals().showRootFocus).toBe(false);
  });

  it('Ack all counts only read-only results with a proposal in that topic', () => {
    const reference = logic(source, {}), items = reference.state.items;
    const candidate = items.find(item => item.id === '1.4')!;
    Object.assign(candidate, { type: 'finding', status: 'open', ack_to: 'done', ask: '' });
    items.push({ ...candidate, id: '99', type: 'explanation' });
    items.push({ ...candidate, id: '98', type: 'explanation', topic: 't2' });
    items.push({ ...candidate, id: '97', type: 'decision' });
    items.push({ ...candidate, id: '96', type: 'question' });
    items.push({ ...candidate, id: '95', type: 'finding', ask: 'Needs an answer first' });
    const values = reference.renderVals();
    expect(values.rows.find(row => row.isTopic && row.topic.id === 't1')).toMatchObject({ ackCount: 2, hasAckAll: true });
    expect(values.rows.find(row => row.isTopic && row.topic.id === 't2')).toMatchObject({ ackCount: 1, hasAckAll: true });
    expect(source).toMatch(/<sc-for list="\{\{ r.counts \}\}"[^\n]+<\/sc-for><sc-if value="\{\{ r.hasAckAll \}\}"/);
  });

  it('Ack all admits whitespace-only asks and answered asks, while excluding closed or unanswered results', () => {
    const reference = logic(source, {}), candidate = reference.state.items.find(item => item.id === '1.4')!;
    Object.assign(candidate, { type: 'finding', status: 'open', ack_to: 'done', ask: '   ' });
    reference.state.items.push({ ...candidate, id: 'sent-result', type: 'explanation', status: 'progress', ask: 'Read this first' });
    reference.state.items.push({ ...candidate, id: 'failed-result', ask: 'Read this first' });
    reference.state.items.push({ ...candidate, id: 'closed-result', status: 'done' });
    reference.state.items.push({ ...candidate, id: 'waiting-result', status: 'waiting' });
    reference.state.subs['sent-result'] = { stage: 'received', text: 'Read', label: 'Read' };
    reference.state.subs['failed-result'] = { stage: 'failed', text: 'Read', label: 'Read' };
    expect(reference.renderVals().rows.find(row => row.isTopic && row.topic.id === 't1')).toMatchObject({ ackCount: 2, hasAckAll: true });
  });

  it('uses actual reference scroll geometry to show only offscreen ancestors', () => {
    const reference = logic(source, { selected: '1.3.1.2' });
    const rows = ['1.3', '1.3.1', '1.3.1.2'].map((id, index) => ({ dataset: { itemId: id },
      getBoundingClientRect: () => ({ top: index < 2 ? -20 : 5, bottom: index < 2 ? -5 : 30 }) }));
    reference.scrollRef.current = { getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => rows,
      querySelector: (selector: string) => rows.find(row => selector.includes(`"${row.dataset.itemId}"`)) };
    reference.rememberMapAncestors();
    expect(reference.state.mapAncestorIds).toEqual(['1.3', '1.3.1']);
    expect(reference.renderVals().mapAncestors).toMatchObject([{ name: 'test fixtures', separator: false }, { name: 'fallback-merge test', separator: true }]);
  });

  it('leaves unrelated source members unchanged', () => {
    const other = '<div>Other page</div>';
    expect(gettingAroundChrome(other)).toBe(other); expect(gettingAroundItemChrome(other)).toBe(other);
  });
});
