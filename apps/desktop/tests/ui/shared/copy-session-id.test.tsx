// copySessionReference: the one copy of a session's connection reference that the connection card and the All
// sessions rows share. It confirms only after the clipboard write lands and never shows the reference.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { copySessionReference } from '../../../src/ui/shared/CopySessionId';
import { notices } from '../../../src/ui/pages/notices';
import { copyText } from '../../../src/ui/shared/clipboard';

vi.mock('../../../src/ui/shared/clipboard', () => ({ copyText: vi.fn() }));
beforeEach(() => { notices.clear(); });
afterEach(() => { notices.clear(); vi.resetAllMocks(); });

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = () => yes(); reject = no; });
  return { promise, resolve, reject };
}
const texts = () => notices.getSnapshot().map(notice => notice.text);
const sessionId = '00000000-0000-4000-8000-0000000000ab';

describe('connection reference copy', () => {
  it('copies the exact reference and confirms only after the clipboard write finishes', async () => {
    const writing = deferred();
    vi.mocked(copyText).mockReturnValue(writing.promise);
    const copied = copySessionReference(sessionId);
    expect(copyText).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(texts()).toEqual([]);
    await act(async () => { writing.resolve(); });
    await expect(copied).resolves.toBe(true);
    expect(texts()).toEqual(['Connection reference copied.']);
    expect(texts().join(' ')).not.toContain(sessionId);
  });

  it('reports a failure in generic words, without the reference or the error, and permits a retry', async () => {
    vi.mocked(copyText).mockRejectedValueOnce(new Error('Denied: secret reference')).mockResolvedValueOnce(undefined);
    await expect(copySessionReference('private reference')).resolves.toBe(false);
    expect(texts()).toEqual(['Copy failed. Try again.']);
    expect(texts().join(' ')).not.toMatch(/private reference|secret reference/);
    notices.clear();
    await expect(copySessionReference('private reference')).resolves.toBe(true);
    expect(texts()).toEqual(['Connection reference copied.']);
  });

  it.each(['resolve', 'reject'] as const)('says nothing for a copy the owner no longer waits for (%s)', async settle => {
    const writing = deferred();
    vi.mocked(copyText).mockReturnValue(writing.promise);
    const copied = copySessionReference(sessionId, () => false);
    await act(async () => { if (settle === 'resolve') writing.resolve(); else writing.reject(new Error('Stale')); });
    await copied;
    expect(texts()).toEqual([]);
  });
});
