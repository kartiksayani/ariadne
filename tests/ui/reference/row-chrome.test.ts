import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { handoffMembers } from '../design/source.mts';
import { itemRowChrome, topicRowChrome } from '../design/row-chrome';

describe('compact tree row design frames', () => {
  const source = handoffMembers()['Item Row.dc.html']!;

  it('puts status beside the title, removes visible IDs and retains the two-row action grid', () => {
    expect(source).toContain('grid-template-rows:repeat(2, auto); grid-auto-flow:column;');
    expect(source).toContain('data-item-id="{{ it.id }}"');
    expect(source).toContain('flex:1 1 12ch; min-width:0; font-size:15px;');
    expect(source).not.toContain('font-family:ui-monospace, Menlo, monospace; font-size:11px;');
    expect(source).toContain('gap:4px 8px; min-width:0;');
    expect(source).toContain('width:26px; height:24px;');
  });

  it('reserves actions before hover and omits the grid when there are no actions', () => {
    expect(source).toContain('showActions: !!(r.actions && r.actions.length),');
    expect(source).toContain("actionVisibility: sel || hov ? 'visible' : 'hidden'");
    expect(source).toContain('visibility:{{ actionVisibility }}; opacity:{{ actionOpacity }};');
    expect(source).not.toContain('showActions: (sel || hov)');
  });

  it('uses accent topic titles while preserving the earlier-topic opacity', () => {
    const topic = handoffMembers()['Ariadne.dc.html']!;
    expect(topic).toContain("nameColor: earlier ? 'color-mix(in srgb, var(--a-acc-text) 82%, transparent)' : 'var(--a-acc-text)'");
    expect(topic).toContain('color:{{ r.nameColor }};');
  });

  it('leaves unrelated reference content unchanged', () => {
    expect(itemRowChrome('<div>Other content</div>')).toBe('<div>Other content</div>');
    expect(topicRowChrome('<div>Other content</div>')).toBe('<div>Other content</div>');
  });

  it('gives topic names the available width and moves their full counts below the action grid', () => {
    const topic = handoffMembers()['Ariadne.dc.html']!;
    expect(topic).toContain('flex:1 1 12em; min-width:0; padding-left:4px;');
    expect(topic).toContain('visibility:{{ r.actionVisibility }}; opacity:{{ r.actionOpacity }};');
    expect(topic).toContain('width:26px; height:22px; padding:0;');
    expect(topic).toContain('showActions: !tsub && acts.length > 0, actions: acts,');
    expect(topic).toMatch(/<\/span>\s*<\/div>\s*<div[^\n]+<sc-for list="\{\{ r.counts \}\}"/);
  });

  it.each([true, false])('replays the font-settled opening for inline=%s and retains ordinary center timers', async inline => {
    const topic = handoffMembers()['Ariadne.dc.html']!;
    expect(topic).toContain('sel, detail: !!props.answering || detail && !!sel, reveal,');
    expect(topic).toContain('answering: null,');
    const method = topic.slice(topic.indexOf('componentDidMount() {'), topic.indexOf('componentDidUpdate('));
    let loadFonts!: () => void;
    const fonts = new Promise<void>(resolve => { loadFonts = resolve; });
    const frames: (() => void)[] = [], timers = vi.fn();
    // Execute the adapted lifecycle from the committed archive, with only its scheduler replaced.
    const lifecycle = runInNewContext(`({${method}})`, { document: { fonts: { ready: fonts } },
      requestAnimationFrame: (callback: () => void) => frames.push(callback), setTimeout: timers }) as { componentDidMount(): void };
    const root = document.createElement('div'), calls: string[] = [];
    const state = { detail: true, answering: null as string | null };
    const instance = { props: { embedded: true, answering: inline ? '2.1.1' : undefined }, rootRef: { current: root },
      railBottom: vi.fn(), scrollToSel: (center: boolean) => {
        expect(center).toBe(true); expect(state.detail).toBe(true); expect(state.answering).toBeNull(); calls.push('center');
      },
      setState: (next: typeof state, done: () => void) => { Object.assign(state, next); calls.push('inline'); done(); } };
    lifecycle.componentDidMount.call(instance);
    expect(calls).toEqual([]);
    if (!inline) {
      expect(timers.mock.calls.map(call => call[1])).toEqual([400, 1200, 2500]);
      expect(frames).toEqual([]);
      return;
    }
    expect(timers).not.toHaveBeenCalled();
    loadFonts(); await fonts; await Promise.resolve();
    frames.shift()!(); expect(calls).toEqual([]);
    frames.shift()!(); expect(calls).toEqual(['center', 'inline']);
    expect(state).toEqual({ detail: false, answering: '2.1.1' });
    expect(root.dataset.inlineAnswerReady).toBeUndefined();
    frames.shift()!(); frames.shift()!();
    expect(root.dataset.inlineAnswerReady).toBe('true');
    expect(timers).not.toHaveBeenCalled(); expect(frames).toEqual([]);
  });
});
