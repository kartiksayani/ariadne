import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog } from '../../../src/ui/dialogs/Dialog';
import { ActionMenu } from '../../../src/ui/shared/ActionMenu';

afterEach(cleanup);
it.each(['Escape', 'Cancel', 'Done'])('returns to the menu trigger after %s when the clicked item held focus', async finish => {
  const user = userEvent.setup();
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><ActionMenu label="Actions" icon={<span>More</span>}>
      {close => <button type="button" role="menuitem" onClick={() => { close(false); setOpen(true); }}>Open form</button>}
    </ActionMenu>{open && <Dialog label="Form" width={520} onCancel={() => setOpen(false)}>
      <button type="button" onClick={() => setOpen(false)}>Cancel</button>
      <button type="button" onClick={() => setOpen(false)}>Done</button>
    </Dialog>}</>;
  }
  render(<Harness />);
  const trigger = screen.getByRole('button', { name: 'Actions' });
  await user.click(trigger);
  const item = screen.getByRole('menuitem', { name: 'Open form' });
  // Native pointer activation can focus an item even though it is outside the tab order.
  item.focus(); expect(document.activeElement).toBe(item);
  fireEvent.click(item, { detail: 1 });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('dialog'));
  if (finish === 'Escape') await user.keyboard('{Escape}');
  else await user.click(screen.getByRole('button', { name: finish }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it('contains forward/reverse Tab across select, textarea and enabled controls, restores opener and consumes Escape', async () => {
  const user = userEvent.setup(), escaped = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(false);
    return <div onKeyDown={escaped}><button onClick={() => setOpen(true)}>Open</button><button>Outside</button>{open && <Dialog label="Form" width={520} onCancel={() => setOpen(false)}>
      <fieldset disabled><button>Disabled group</button></fieldset><input type="hidden" /><button hidden>Hidden</button>
      <select aria-label="Choice"><option>First</option></select><textarea aria-label="Message" /><button disabled>Disabled</button>
      <button onClick={() => setOpen(false)}>Cancel</button>
    </Dialog>}</div>;
  }
  render(<Harness />); await user.click(screen.getByRole('button', { name: 'Open' }));
  const dialog = screen.getByRole('dialog'), choice = screen.getByLabelText('Choice'), message = screen.getByLabelText('Message'), cancel = screen.getByRole('button', { name: 'Cancel' });
  // The card holds focus first; its controls follow in order.
  expect(document.activeElement).toBe(dialog);
  await user.tab(); expect(document.activeElement).toBe(choice);
  await user.tab(); expect(document.activeElement).toBe(message);
  await user.tab(); expect(document.activeElement).toBe(cancel);
  await user.tab(); expect(document.activeElement).toBe(choice);
  await user.tab({ shift: true }); expect(document.activeElement).toBe(cancel);
  screen.getByRole('button', { name: 'Outside' }).focus(); expect(document.activeElement).toBe(dialog);
  escaped.mockClear(); fireEvent.keyDown(message, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(escaped).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open' }));
});
it('keeps a dialog focusable when asynchronous controls are all disabled', async () => {
  const user = userEvent.setup();
  render(<Dialog label="Saving" width={520} onCancel={() => {}}><textarea disabled /><button disabled>Saving</button></Dialog>);
  const dialog = screen.getByRole('dialog'); expect(document.activeElement).toBe(dialog);
  await user.tab(); expect(document.activeElement).toBe(dialog);
  await user.tab({ shift: true }); expect(document.activeElement).toBe(dialog);
});
