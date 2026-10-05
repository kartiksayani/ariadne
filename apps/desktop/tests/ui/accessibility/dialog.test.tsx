import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReferenceDialog } from '../../../src/components/reference/ReferenceDialog';

afterEach(cleanup);
it('contains forward/reverse Tab across select, textarea and enabled controls, restores opener and consumes Escape', async () => {
  const user = userEvent.setup(), escaped = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(false);
    return <div onKeyDown={escaped}><button onClick={() => setOpen(true)}>Open</button><button>Outside</button>{open && <ReferenceDialog title="Form" onCancel={() => setOpen(false)} actions={<button onClick={() => setOpen(false)}>Cancel</button>}>
      <fieldset disabled><button>Disabled group</button></fieldset><input type="hidden" /><button hidden>Hidden</button>
      <select aria-label="Choice"><option>First</option></select><textarea aria-label="Message" /><button disabled>Disabled</button>
    </ReferenceDialog>}</div>;
  }
  render(<Harness />); await user.click(screen.getByRole('button', { name: 'Open' }));
  const choice = screen.getByLabelText('Choice'), message = screen.getByLabelText('Message'), cancel = screen.getByRole('button', { name: 'Cancel' });
  expect(document.activeElement).toBe(choice);
  await user.tab(); expect(document.activeElement).toBe(message);
  await user.tab(); expect(document.activeElement).toBe(cancel);
  await user.tab(); expect(document.activeElement).toBe(choice);
  await user.tab({ shift: true }); expect(document.activeElement).toBe(cancel);
  screen.getByRole('button', { name: 'Outside' }).focus(); expect(document.activeElement).toBe(choice);
  escaped.mockClear(); fireEvent.keyDown(message, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(escaped).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open' }));
});
it('keeps a dialog focusable when asynchronous controls are all disabled', async () => {
  const user = userEvent.setup();
  render(<ReferenceDialog title="Saving" onCancel={() => {}} actions={<button disabled>Saving</button>}><textarea disabled /></ReferenceDialog>);
  const dialog = screen.getByRole('dialog'); expect(document.activeElement).toBe(dialog);
  await user.tab(); expect(document.activeElement).toBe(dialog);
  await user.tab({ shift: true }); expect(document.activeElement).toBe(dialog);
});
