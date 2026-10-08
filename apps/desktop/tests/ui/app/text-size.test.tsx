import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport } from './transport';

afterEach(() => { cleanup(); document.documentElement.style.removeProperty('--text-scale'); });

describe('saved app text size', () => {
  it('starts at 80%, persists the Aa choices, and restores the chosen size on restart', async () => {
    const transport = new AppTransport();
    const app = () => <DesktopApp service={createDesktopService(transport)} />;
    const { unmount } = render(app());
    const button = await screen.findByRole('button', { name: 'Text size' });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('0.8');
    for (const size of [70, 80, 90, 100, 110, 120]) {
      fireEvent.click(button);
      fireEvent.click(within(screen.getByRole('group', { name: 'Text size' })).getByRole('button', { name: `${size}%${size === 80 ? ' (default)' : ''}` }));
      await waitFor(() => expect(transport.preferences.global.text_scale).toBe(size));
      await waitFor(() => expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe(String(size / 100)));
      await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    }
    unmount(); render(app());
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('1.2'));
  });

  it('saves the window shortcuts from a focused text field and resets to the smaller default', async () => {
    const transport = new AppTransport();
    transport.preferences.global.text_scale = 100;
    render(<DesktopApp service={createDesktopService(transport)} />);
    const button = await screen.findByRole('button', { name: 'Text size' });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    const field = screen.getByRole('textbox', { name: 'Search questions and outcomes' }); field.focus();
    for (const [key, size] of [['-', 90], ['+', 100], ['=', 110], ['0', 80]] as const) {
      const event = new KeyboardEvent('keydown', { key, metaKey: true, shiftKey: key === '+', bubbles: true, cancelable: true });
      fireEvent(field, event);
      expect(event.defaultPrevented).toBe(true);
      await waitFor(() => expect(transport.preferences.global.text_scale).toBe(size));
      await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
      expect(document.activeElement).toBe(field);
    }
  });
});
