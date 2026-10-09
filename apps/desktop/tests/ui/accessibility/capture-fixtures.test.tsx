import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { frameIds, graphFrame } from '../../../../../tests/ui/design/frames';
import { designFixture, prototypeData } from '../../../../../tests/ui/design/fixtures';
import { handoffMembers } from '../../../../../tests/ui/design/source.mts';

const data = prototypeData(handoffMembers()['Ariadne.dc.html']);
afterEach(cleanup);

it('refuses handoff frames without a fixture', () => {
  expect(() => designFixture('1s', data)).toThrow('fixture not written: 1s');
});

it.each(frameIds)('mounts DesktopApp in design frame %s through the real stores', async id => {
  const fixture = designFixture(id, data), spec = fixture.spec;
  render(<DesktopApp service={createDesktopService(fixture.transport)} />);
  await waitFor(() => expect(document.querySelector('.shell-summary')?.textContent).toMatch(/^\d+ items/));
  expect(document.documentElement.dataset.theme).toBe(spec.theme);
  if (!fixture.route) { await screen.findByRole('heading', { level: 1 }); return; }
  if (spec.state === 'loading') { expect(await screen.findAllByText(/^Reading the session…/)).not.toHaveLength(0); return; }
  if (spec.scenario === 'archive') {
    await screen.findByRole('heading', { name: 'Archived topics' });
    await waitFor(() => expect(document.querySelectorAll('.pw-archive-card').length).toBeGreaterThan(0));
    return;
  }
  await screen.findByRole('region', { name: 'Session tree' });
  if (spec.state !== 'empty' && !graphFrame(spec)) await screen.findByRole('tree', { name: 'Session items' });
  if (spec.state === 'empty') expect(await screen.findByText('No items yet', { exact: false })).toBeTruthy();
  if (spec.state === 'clear') expect(await screen.findByText('Nothing waiting on you')).toBeTruthy();
  if (spec.selected) await waitFor(() => expect(document.querySelector<HTMLElement>('.shell-detail .item-detail')?.dataset.detailItemId).toBe(spec.selected));
});
