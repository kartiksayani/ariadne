import { useEffect, useState } from 'react';
import type { Theme } from '../../generated/core';
import type { ShellTheme } from './model';

const query = '(prefers-color-scheme: dark)';
const prefersDark = () => window.matchMedia?.(query)?.matches !== false;

/** The saved preference resolved to the theme on screen; `system` follows the OS. */
export function resolveTheme(theme: Theme, dark: boolean): ShellTheme {
  return theme === 'system' ? dark ? 'dark' : 'light' : theme;
}

/** Applies the resolved theme to <html data-theme> and returns it. */
export function useAppliedTheme(theme: Theme): ShellTheme {
  const [dark, setDark] = useState(prefersDark);
  useEffect(() => {
    if (theme !== 'system') return undefined;
    const media = window.matchMedia?.(query);
    const update = () => setDark(media?.matches !== false);
    update();
    media?.addEventListener('change', update);
    return () => media?.removeEventListener('change', update);
  }, [theme]);
  const resolved = resolveTheme(theme, dark);
  useEffect(() => { document.documentElement.dataset.theme = resolved; }, [resolved]);
  return resolved;
}
