import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createDesktopService, immutable, OpenSessions } from '../../../src/data';
import { SessionActions } from '../../../src/components/bindings/actions';
import { StuckNote } from '../../../src/ui/answer/StuckNote';
import { AppTransport, route } from '../app/transport';

describe('delivery explanation text', () => {
  it('keeps the full sentence findable as plain text and preserves the exact copied explanation', async () => {
    const transport = new AppTransport(), service = createDesktopService(transport), sessions = new OpenSessions(service);
    const store = sessions.open(route);
    try {
      await store.refresh();
      const input = structuredClone(Object.values(store.getSnapshot().snapshot!.session.inputs).find(value => value?.state === 'needs_attention')!);
      const attempt = input.attempts.find(value => value.id === input.active_attempt_id)!;
      Object.assign(attempt, { acceptance: 'rejected', turn_state: 'failed' });
      const text = 'Couldn’t deliver “Approve”.  Ariadne isn’t sure it reached claude-code.\nReview it.';
      render(<StuckNote actions={new SessionActions(service, store)} input={immutable(input)}
        stuck={{ kind: 'decision', text, retry: true, settle: 'skip', resume: false }} />);
      const status = screen.getByRole('status');
      expect(status.textContent).toBe(text);
      expect(screen.getByText(text.replace(/\s+/g, ' '))).toBe(status);
      expect(status.childElementCount).toBe(0);
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    } finally { cleanup(); sessions.closeAll(); }
  });
});
