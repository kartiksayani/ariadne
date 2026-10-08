import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { useRef } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_TEXT_SIZE, TEXT_SIZES, nextTextSize, textSize, useAppliedTextSize } from '../../../src/ui/shell/textScale';
import { TextSizeControl } from '../../../src/ui/shell/TextSizeControl';
import { useWindowKeys } from '../../../src/ui/shell/windowKeys';
import { workspaceIntent } from '../../../src/ui/keys';
import { designFixture, prototypeData } from '../../../../../tests/ui/design/fixtures';
import { frameIds } from '../../../../../tests/ui/design/frames';
import { handoffMembers } from '../../../../../tests/ui/design/source.mts';

afterEach(() => { cleanup(); document.documentElement.style.removeProperty('--text-scale'); });

describe('text size', () => {
  it('defaults to 80% including old or invalid preferences', () => {
    expect(DEFAULT_TEXT_SIZE).toBe(80);
    for (const value of [undefined, 85, 0, NaN]) expect(textSize(value)).toBe(80);
    const { result } = renderHook(() => useAppliedTextSize());
    expect(result.current).toBe(80);
    expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('0.8');
    const tokens = readFileSync(resolve('apps/desktop/public/styles/design-tokens.css'), 'utf8');
    expect(tokens).toContain('--text-scale: 0.8;');
  });

  it('applies each step to the root and steps within the limits', () => {
    const { result, rerender } = renderHook(({ size }) => useAppliedTextSize(size), { initialProps: { size: 80 } });
    for (const [index, size] of TEXT_SIZES.entries()) {
      rerender({ size }); expect(result.current).toBe(size);
      expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe(String(size / 100));
      expect(nextTextSize(size, 'text-smaller')).toBe(TEXT_SIZES[Math.max(0, index - 1)]);
      expect(nextTextSize(size, 'text-larger')).toBe(TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, index + 1)]);
      expect(nextTextSize(size, 'text-default')).toBe(80);
    }
  });

  it('offers each size next to Aa with shortcut hints and selected feedback', () => {
    const change = vi.fn();
    render(<TextSizeControl size={80} onChange={change} />);
    const button = screen.getByRole('button', { name: 'Text size' });
    expect(button.title).toContain('⌘−'); expect(button.title).toContain('⌘+');
    expect(button.title).toContain('⌘='); expect(button.title).toContain('⌘0');
    for (const size of TEXT_SIZES) {
      fireEvent.click(button);
      const menu = screen.getByRole('group', { name: 'Text size' });
      const option = within(menu).getByRole('button', { name: `${size}%${size === 80 ? ' (default)' : ''}` });
      expect(option.getAttribute('aria-pressed')).toBe(String(size === 80));
      fireEvent.click(option); expect(change).toHaveBeenLastCalledWith(size);
      expect(button.getAttribute('aria-expanded')).toBe('false');
    }
    fireEvent.click(button); fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Text size' })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('routes shortcuts once from body and text fields and consumes browser zoom even when keys stop bubbling', () => {
    const change = vi.fn();
    function Workspace() {
      const root = useRef<HTMLDivElement>(null);
      useWindowKeys(root, undefined, change);
      return <div ref={root}><input aria-label="Search" /><textarea aria-label="Reply" onKeyDown={event => event.stopPropagation()} /></div>;
    }
    render(<Workspace />);
    for (const target of [document.body, screen.getByRole('textbox', { name: 'Search' }), screen.getByRole('textbox', { name: 'Reply' })]) {
      if (target !== document.body) target.focus();
      for (const [key, kind] of [['-', 'text-smaller'], ['+', 'text-larger'], ['=', 'text-larger'], ['0', 'text-default']] as const) {
        expect(workspaceIntent({ key, metaKey: true })).toEqual({ kind });
        const event = new KeyboardEvent('keydown', { key, metaKey: true, shiftKey: key === '+', bubbles: true, cancelable: true });
        const before = change.mock.calls.length;
        fireEvent(target, event);
        expect(change).toHaveBeenLastCalledWith(kind);
        expect(change.mock.calls.length).toBe(before + 1);
        expect(event.defaultPrevented).toBe(true);
      }
    }
    change.mockClear();
    fireEvent.keyDown(document.body, { key: '+', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: '+', metaKey: true, isComposing: true });
    expect(change).not.toHaveBeenCalled();
  });

  it('pins every reference design fixture to 100% while the product default is 80%', () => {
    const data = prototypeData(handoffMembers()['Ariadne.dc.html']);
    for (const id of frameIds) expect(designFixture(id, data).transport.preferences.global.text_scale).toBe(100);
    expect(textSize()).toBe(80);
  });
});
