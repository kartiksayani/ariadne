import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { copyText } from '../../../src/ui/shared/clipboard';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));

afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe('clipboard routing', () => {
  const raw = '  **keep markdown**\n\n```rs\nlet name = "日本語";\n```\n';

  it('writes unchanged text through the native command in Tauri', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(invoke).mockResolvedValue(undefined);
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await copyText(raw);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('clipboard_write', { text: raw });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('uses the browser clipboard in a preview', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await copyText(raw);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(raw);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects a failed native write without retrying through the WebView', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(invoke).mockRejectedValue(new Error('Native write failed'));
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyText(raw)).rejects.toThrow('Native write failed');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rejects unavailable, failed and synchronously throwing browser writes', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    vi.stubGlobal('navigator', {});
    await expect(copyText(raw)).rejects.toThrow('Clipboard unavailable');
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => Promise.reject(new Error('Denied'))) } });
    await expect(copyText(raw)).rejects.toThrow('Denied');
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => { throw new Error('Unavailable'); }) } });
    await expect(copyText(raw)).rejects.toThrow('Unavailable');
  });
});
