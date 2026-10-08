import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ItemDetail } from '../../../src/ui/detail/ItemDetail';
import { FileRefProject, FileRefs, LinkOpener, type FileOpener } from '../../../src/ui/shared/MarkdownText';
import type { ItemLinkTarget } from '../../../src/generated/domain/models';
import { OwnerDraftStore } from '../../../src/state/drafts/store';
import { setup } from './fixtures';

const opened: ReturnType<typeof setup>[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(value => value.sessions.closeAll()); vi.restoreAllMocks(); });

async function panel(links: ItemLinkTarget[], exists: readonly string[] = []) {
  const value = setup(); opened.push(value);
  value.transport.session.items['1']!.links = links;
  await value.store.refresh();
  const open = vi.fn(), openItem = vi.fn(), files = {
    resolve: vi.fn((_project: string, references: readonly string[]) => Promise.resolve(references.map(text => exists.includes(text)))),
    open: vi.fn(),
  } satisfies FileOpener;
  const project = value.transport.session.project_id;
  render(<LinkOpener.Provider value={open}><FileRefs.Provider value={files}><FileRefProject.Provider value={project}>
    <ItemDetail drafts={new OwnerDraftStore(value.service)} store={value.store} itemId="1" later={false} onOpenItem={openItem} />
  </FileRefProject.Provider></FileRefs.Provider></LinkOpener.Provider>);
  await screen.findByRole('heading', { name: value.transport.session.items['1']!.question });
  return { open, openItem, files, project, region: screen.getByRole('region', { name: 'Item links' }) };
}

describe('item links in the detail panel', () => {
  it('opens item links in this session with a plain-language tooltip, by click and Enter', async () => {
    const { open, openItem, files, region } = await panel([{ kind: 'item', label: 'Receipt follow-up', target: '1.1' }]);
    const link = within(region).getByRole('link', { name: 'Receipt follow-up' });
    expect(link.getAttribute('title')).toBe('Add the receipt lookup… · Open');
    expect(link.getAttribute('title')).not.toContain('1.1');
    fireEvent.click(link);
    fireEvent.keyDown(link, { key: 'Enter' });
    expect(openItem.mock.calls).toEqual([['1.1'], ['1.1']]);
    expect(open).not.toHaveBeenCalled();
    expect(files.open).not.toHaveBeenCalled();
  });

  it('shows missing item links as plain text instead of sending them to the external opener', async () => {
    const { open, openItem, region } = await panel([{ kind: 'item', label: 'Missing follow-up', target: '99.1' }]);
    expect(within(region).queryByRole('link')).toBeNull();
    expect(within(region).getByText('Missing follow-up')).toBeTruthy();
    expect(within(region).getByText('(item not found)').className).toBe('md-item-missing');
    expect(open).not.toHaveBeenCalled();
    expect(openItem).not.toHaveBeenCalled();
  });
  it('opens a web link in the browser and shows its address on hover', async () => {
    const { open, region } = await panel([{ kind: 'pr', label: 'Fix the cache', target: 'https://github.com/o/r/pull/7' }]);
    const link = within(region).getByRole('link', { name: 'Fix the cache' });
    expect(link.getAttribute('href')).toBe('https://github.com/o/r/pull/7');
    expect(link.getAttribute('title')).toBe('https://github.com/o/r/pull/7');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(link, click);
    expect(click.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith('https://github.com/o/r/pull/7');
  });

  it('opens a mailto link through the same opener', async () => {
    const { open, region } = await panel([{ kind: 'doc', label: 'Ask Sam', target: 'mailto:sam@example.com' }]);
    fireEvent.click(within(region).getByRole('link', { name: 'Ask Sam' }));
    expect(open).toHaveBeenCalledWith('mailto:sam@example.com');
  });

  it('opens a file the desktop finds in the project through the file opener', async () => {
    const { open, files, project, region } = await panel([{ kind: 'file', label: 'The store', target: 'crates/store/src/lib.rs:12' }], ['crates/store/src/lib.rs:12']);
    const link = await within(region).findByRole('link', { name: 'The store' });
    expect(link.getAttribute('href')).toBeNull();
    expect(link.getAttribute('title')).toBe('Open lib.rs (line 12) in your text editor');
    expect(files.resolve).toHaveBeenCalledWith(project, ['crates/store/src/lib.rs:12']);
    fireEvent.click(link);
    expect(files.open).toHaveBeenCalledWith(project, 'crates/store/src/lib.rs:12');
    fireEvent.keyDown(link, { key: 'Enter' });
    expect(files.open).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();
  });

  it('shows a file that does not resolve as plain text with its label', async () => {
    const { files, region } = await panel([{ kind: 'file', label: 'Gone file', target: 'src/gone.rs' }], []);
    await vi.waitFor(() => expect(files.resolve).toHaveBeenCalled());
    expect(within(region).queryAllByRole('link')).toHaveLength(0);
    expect(region.querySelector('a')).toBeNull();
    expect(within(region).getByText('Gone file')).toBeTruthy();
  });

  it('shows an unsafe or unopenable target as plain text', async () => {
    const { open, files, region } = await panel([
      { kind: 'pr', label: 'Script', target: 'javascript:alert(1)' },
      { kind: 'doc', label: 'Odd target', target: 'not a path or address' },
      { kind: 'pr', label: 'Local web', target: 'ftp://example.com/x' },
    ], ['javascript:alert(1)']);
    expect(region.querySelector('a')).toBeNull();
    expect(within(region).queryAllByRole('link')).toHaveLength(0);
    for (const label of ['Script', 'Odd target', 'Local web']) expect(within(region).getByText(label)).toBeTruthy();
    expect(files.resolve).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('never renders an anchor that points at "#"', async () => {
    await panel([
      { kind: 'pr', label: 'Web', target: 'https://example.com/a' },
      { kind: 'file', label: 'File', target: 'src/a.ts' },
      { kind: 'doc', label: 'Nothing', target: 'x y' },
    ], ['src/a.ts']);
    await screen.findByRole('link', { name: 'File' });
    expect(document.querySelectorAll('a[href="#"]')).toHaveLength(0);
  });
});
