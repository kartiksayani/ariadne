import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from '../../src/App';

afterEach(cleanup);
test('diagnostic form edits fields and reports a genuinely unavailable native transport', async () => {
  render(<App />);
  expect(screen.getByText(/temporary diagnostic/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Nonce'), { target: { value: '1'.repeat(64) } });
  fireEvent.change(screen.getByLabelText('Payload'), { target: { value: 'unit diagnostic' } });
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('transport_unavailable'));
  expect(document.getElementById('receipt')?.textContent).toBe('');
});
test('real frontend entry mounts its scaffold in the browser test environment', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  await import('../../src/main');
  await waitFor(() => expect(screen.getByRole('heading').textContent).toBe('Ariadne scaffold'));
});
