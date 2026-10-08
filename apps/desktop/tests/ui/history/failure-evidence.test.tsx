import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error The native e2e helpers are plain ESM without type declarations.
import { historyFailureFacts, withFailureEvidence } from '../../e2e/history-evidence.mjs';

afterEach(() => { document.body.innerHTML = ''; });

describe('native history failure evidence', () => {
  it('reports the disabled Messages toggle, pending navigation state and owner-input lock', () => {
    document.body.innerHTML = `<header class="shell-header"><button title="Messages (m)" aria-label="Messages (m)" disabled></button></header>
      <div class="nav-banner" role="alert"><p>Preferences revision changed</p></div>
      <button disabled>Refreshing…</button><button>Check again</button>
      <input data-shell-search disabled value="needle"><p role="status">Search preview · save pending</p>
      <div role="treeitem" data-item-id="1.1" aria-selected="true"></div>
      <div class="detail-box" data-owner-input="1"><textarea disabled>abc</textarea>
        <div class="detail-box-row"><button class="btn btn-primary" disabled>Send reply</button></div><p role="status">Save completion is unknown.</p></div>`;
    const facts = historyFailureFacts();
    expect(facts.messagesToggle).toMatchObject({ titled: { disabled: true }, ariaLabel: 'Messages (m)', railOpen: false });
    expect(facts.navigation.banners).toEqual([{ role: 'alert', text: 'Preferences revision changed' }]);
    expect(facts.navigation.stateButtons).toEqual([{ text: 'Refreshing…', disabled: true, ariaPressed: null },
      { text: 'Check again', disabled: false, ariaPressed: null }]);
    expect(facts.navigation.disabledHeaderButtons).toEqual(['Messages (m)']);
    expect(facts.search).toMatchObject({ present: true, disabled: true, value: 'needle', statusLabel: 'Search preview · save pending' });
    expect(facts.selected.treeItemIds).toEqual(['1.1']);
    expect(facts.ownerInput).toMatchObject({ present: true, itemId: '1' });
    expect(facts.ownerInput.textarea).toEqual({ disabled: true, valueLength: 3 });
    expect(facts.ownerInput.send).toMatchObject({ text: 'Send reply', disabled: true });
    expect(facts.ownerInput.statuses).toEqual(['Save completion is unknown.']);
    expect(facts.ownerInput).toHaveProperty('innerText');
  });
  it('reports absent controls without throwing', () => {
    const facts = historyFailureFacts();
    expect(facts.messagesToggle.titled).toBeNull(); expect(facts.search.present).toBe(false); expect(facts.ownerInput.present).toBe(false);
  });
  it('records evidence then rethrows the identical wait error, even when recording fails', async () => {
    const failure = new Error('wait timed out'); let recorded: unknown = null;
    await expect(withFailureEvidence(async () => { throw failure; }, async (error: unknown) => { recorded = error; })).rejects.toBe(failure);
    expect(recorded).toBe(failure);
    await expect(withFailureEvidence(async () => { throw failure; }, async () => { throw new Error('disk full'); })).rejects.toBe(failure);
    await expect(withFailureEvidence(async () => 'ok', async () => { throw new Error('unused'); })).resolves.toBe('ok');
  });
});
