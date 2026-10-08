import { describe, expect, it, vi } from 'vitest';
import { NoticeStore } from '../../../src/ui/pages/notices';
import { FILE_NOT_OPENED, LINK_NOT_OPENED, fileOpener, linkOpener } from '../../../src/ui/shared/openers';

const flush = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });

describe('opening links and files named in agent text', () => {
  it('says so when a link did not open, and stays quiet when it did', async () => {
    const store = new NoticeStore(), openLink = vi.fn<(url: string) => Promise<void>>(async () => {});
    linkOpener({ openLink }, store)('https://example.com');
    await flush();
    expect(openLink).toHaveBeenCalledWith('https://example.com');
    expect(store.getSnapshot()).toHaveLength(0);
    linkOpener({ openLink: async () => { throw new Error('no browser'); } }, store)('https://example.com');
    await flush();
    expect(store.getSnapshot().map(notice => notice.text)).toEqual([LINK_NOT_OPENED]);
    // The same failure again replaces the note rather than stacking.
    linkOpener({ openLink: async () => { throw new Error('no browser'); } }, store)('https://example.com');
    await flush();
    expect(store.getSnapshot()).toHaveLength(1);
  });

  it('does nothing for a link when the desktop cannot open links', () => {
    const store = new NoticeStore();
    linkOpener({}, store)('https://example.com');
    expect(store.getSnapshot()).toHaveLength(0);
  });

  it('says so when a file did not open, and stays quiet when it did', async () => {
    const store = new NoticeStore(), openFileReference = vi.fn<(project: string, reference: string) => Promise<void>>(async () => {});
    const resolveFileReferences = async () => [true];
    fileOpener({ resolveFileReferences, openFileReference }, store)!.open('p', 'src/a.rs:1');
    await flush();
    expect(openFileReference).toHaveBeenCalledWith('p', 'src/a.rs:1');
    expect(store.getSnapshot()).toHaveLength(0);
    fileOpener({ resolveFileReferences, openFileReference: async () => { throw new Error('refused'); } }, store)!.open('p', 'src/a.rs');
    await flush();
    expect(store.getSnapshot().map(notice => notice.text)).toEqual([FILE_NOT_OPENED]);
  });

  it('offers no file opener when the desktop cannot resolve and open files', async () => {
    expect(fileOpener({})).toBeNull();
    expect(fileOpener({ resolveFileReferences: async () => [] })).toBeNull();
    const resolveFileReferences = vi.fn(async () => [false]);
    expect(await fileOpener({ resolveFileReferences, openFileReference: async () => {} })!.resolve('p', ['x'])).toEqual([false]);
  });
});
