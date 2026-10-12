import { describe, expect, it } from 'vitest';
import { handoffMembers } from '../design/source.mts';
import { itemRowChrome, topicRowChrome } from '../design/row-chrome';

describe('compact tree row design frames', () => {
  const source = handoffMembers()['Item Row.dc.html']!;

  it('stacks the status and ordinal above a two-row action grid with unchanged buttons', () => {
    expect(source).toContain('grid-template-rows:repeat(2, auto); grid-auto-flow:column;');
    expect(source).toContain('order:-1; display:flex; flex-direction:column; align-items:flex-end; gap:2px;');
    expect(source).toContain('width:26px; height:24px;');
  });

  it('reserves actions before hover and omits the grid when there are no actions', () => {
    expect(source).toContain('showActions: !!(r.actions && r.actions.length),');
    expect(source).toContain("actionVisibility: sel || hov ? 'visible' : 'hidden'");
    expect(source).toContain('visibility:{{ actionVisibility }}; opacity:{{ actionOpacity }};');
    expect(source).not.toContain('showActions: (sel || hov)');
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
});
