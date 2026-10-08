import { invoke, isTauri } from '@tauri-apps/api/core';

/** Copy the source text unchanged, using the system clipboard in the desktop app. */
export async function copyText(text: string): Promise<void> {
  if (isTauri()) {
    await invoke('clipboard_write', { text });
    return;
  }
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
  await navigator.clipboard.writeText(text);
}
