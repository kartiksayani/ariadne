import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { DesktopApp } from '../../../src/App';
import { createDesktopService } from '../../../src/data/service';
import { loadItemHistory } from '../../../src/components/history/load';
import { ordinaryCases, type OrdinaryCase } from '../../../../../tests/visual/cases';
import { createOrdinaryCapture } from '../../../../../tests/visual/fixture';

afterEach(cleanup);
it.each(ordinaryCases)('mounts ordinary DesktopApp frame $id through the existing transport and stores', async value => {
  const scenario: OrdinaryCase = value, capture = createOrdinaryCapture(new URLSearchParams({ frame: value.id, theme: 'light' }));
  const service = createDesktopService(capture.transport); render(<DesktopApp service={service} />);
  if (scenario.navigation) await screen.findByRole('heading', { level: 1 });
  else if (scenario.loading) await screen.findByText('Loading session…', { exact: true });
  else {
    await screen.findByRole('tree', { name: 'Sentences' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause dispatch' }).hasAttribute('disabled')).toBe(false));
    if (scenario.item) {
      await waitFor(() => expect(document.querySelector('.shell-detail-scroll .owner-input textarea')).not.toBeNull());
      const history = await loadItemHistory(service, capture.route, scenario.item, capture.snapshot.revision);
      expect(history.item.item.id).toBe(scenario.item);
      if (scenario.id === '1u') { expect(history.rounds.rounds.items).toHaveLength(3); expect(history.rounds.rounds.items.flatMap(round => round.forks.items)).toHaveLength(2); }
    }
    if (scenario.empty) expect(await screen.findByText('No items yet')).toBeTruthy();
    if (scenario.clear) expect(await screen.findByText('Nothing waiting on you')).toBeTruthy();
    if (scenario.answered) {
      expect(await screen.findAllByText('Please use the afternoon delivery.')).not.toHaveLength(0);
      expect([...document.querySelectorAll('.ref-waiting-card')].some(card => card.textContent?.includes('Which delivery window?'))).toBe(false);
    }
  }
});
