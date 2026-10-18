import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DetailPath } from '../../../src/ui/detail/DetailPath';
import { setup } from '../history/fixtures';

const opened: ReturnType<typeof setup>[] = [];
afterEach(() => { cleanup(); opened.splice(0).forEach(value => value.sessions.closeAll()); });

/** A chain topic > a > b > c > leaf: five levels above the leaf's title. */
async function chain() {
  const value = setup(); opened.push(value);
  const session = value.transport.session, items = session.items;
  const [a, b, c, leaf] = [items['1']!, items['1.1']!, items['2']!, items['8']!];
  for (const item of [b, c, leaf]) item.topic_id = a.topic_id;
  a.parent = null; b.parent = a.id; c.parent = b.id; leaf.parent = c.id;
  for (const item of [a, b, c, leaf]) item.short = `Level ${item.id}`;
  await value.store.refresh();
  return { value, a, b, c, leaf, topic: session.topics[a.topic_id]! };
}

describe('DetailPath', () => {
  it('folds more than three levels to first, second, "…" and last, and "…" shows the full path', async () => {
    const { value, a, b, c, topic } = await chain();
    const open = vi.fn();
    render(<DetailPath store={value.store} itemId="8" onOpenItem={open} />);
    const nav = screen.getByRole('navigation', { name: 'Item location' });
    expect(nav.querySelectorAll('.detail-crumb')).toHaveLength(4);
    expect(screen.getByRole('button', { name: topic.name })).toBeTruthy();
    expect(screen.getByRole('button', { name: a.question })).toBeTruthy();
    expect(screen.queryByRole('button', { name: b.question })).toBeNull();
    expect(screen.getByRole('button', { name: c.question })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show the full path' }));
    expect(nav.querySelectorAll('.detail-crumb')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Show the full path' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: b.question })); expect(open).toHaveBeenCalledWith(b.id);
  });

  it('keeps a short path whole', async () => {
    const { value } = await chain();
    render(<DetailPath store={value.store} itemId="2" onOpenItem={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Show the full path' })).toBeNull();
  });

  it('runs onTopic from the topic segment', async () => {
    const { value, topic } = await chain();
    const top = vi.fn();
    render(<DetailPath store={value.store} itemId="8" onOpenItem={vi.fn()} onTopic={top} />);
    fireEvent.click(screen.getByRole('button', { name: topic.name })); expect(top).toHaveBeenCalledOnce();
  });

  it('shows the topic alone in topic mode, and nothing for an unknown topic', async () => {
    const { value, topic } = await chain();
    const { rerender } = render(<DetailPath store={value.store} topicId={topic.id} onOpenItem={vi.fn()} />);
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([topic.name]);
    rerender(<DetailPath store={value.store} topicId="missing" onOpenItem={vi.fn()} />);
    expect(screen.queryAllByRole('button')).toEqual([]);
  });
});
