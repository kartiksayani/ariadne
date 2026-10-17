// Failure evidence for history waits. Runs in the WebView via browser.execute, so it must stay
// self-contained and read only DOM facts the product already renders.
export function historyFailureFacts() {
  const text = node => node?.textContent?.trim() ?? null;
  const all = selector => [...document.querySelectorAll(selector)];
  const control = node => node ? { text: text(node), disabled: Boolean(node.disabled), ariaPressed: node.getAttribute('aria-pressed') } : null;
  // The detail's owner input: the answer slot of a waiting item, else the open action box with its changed-target warning.
  const owner = document.querySelector('[data-owner-input]');
  const editor = owner?.querySelector('textarea') ?? null;
  const send = owner?.querySelector('[data-answer-send], .detail-composer-row button[aria-label^="Send "], .detail-box-row .btn-primary') ?? null;
  // The top bar's search is its idle button until it opens into the field.
  const search = document.querySelector('.shell-top input[aria-label="Search the Map"], .shell-top button[aria-label="Search the Map"]');
  const stateButtons = /^(Refresh|Refreshing…|Check again|Register project|Connect existing session|Try saving your draft again|Try sending again|Write another input)$/;
  const active = document.activeElement;
  return {
    conversation: { present: Boolean(document.querySelector('.item-detail [aria-label="Conversation"]')),
      messageIds: all('.detail-chat-list > li[data-message-id]').map(node => node.getAttribute('data-message-id')),
      scroll: (() => { const pane = document.querySelector('.item-detail .detail-body');
        return pane ? { top: pane.scrollTop, height: pane.scrollHeight, viewport: pane.clientHeight } : null; })() },
    // chromeDisabled follows writing / refreshPending / missing preferences; these labels expose that state.
    navigation: { banners: all('.nav-banner').map(node => ({ role: node.getAttribute('role'), text: text(node) })),
      alerts: all('[role="alert"]').map(text), statuses: all('[role="status"]').map(text),
      stateButtons: all('button').filter(button => stateButtons.test(text(button) ?? '')).map(control),
      disabledHeaderButtons: all('.shell-top button').filter(button => button.disabled).map(button => button.title || text(button)) },
    search: { present: Boolean(search), disabled: search ? search.disabled : null, value: search?.value ?? null,
      statusLabel: all('[role="status"]').map(text).find(label => label?.startsWith('Search preview')) ?? null },
    selected: { treeItemIds: all('[data-item-id][aria-selected="true"], [data-item-id][aria-current]').map(node => node.getAttribute('data-item-id')),
      detailHeader: document.querySelector('.item-detail')?.getAttribute('data-detail-item-id') ?? null,
      detailQuestion: text(document.querySelector('.item-detail .detail-question')),
      rounds: all('.item-detail .detail-chat-list li[data-round]').map(node => node.getAttribute('data-round')) },
    ownerInput: { present: Boolean(owner), itemId: owner?.getAttribute('data-owner-input') ?? null,
      textarea: editor ? { disabled: editor.disabled, valueLength: editor.value.length } : null,
      send: control(send), buttons: owner ? [...owner.querySelectorAll('button')].map(control) : [],
      alerts: owner ? [...owner.querySelectorAll('[role="alert"]')].map(text) : [],
      statuses: owner ? [...owner.querySelectorAll('[role="status"]')].map(text) : [],
      blocked: text(owner?.querySelector('.answer-blocked') ?? null),
      // Identifies a missing editor: "Loading saved drafts…", the receipt view or a locked draft all render here.
      innerText: owner?.innerText ?? null },
    activeElement: active ? { tag: active.tagName, className: String(active.className), title: active.getAttribute('title'), ariaLabel: active.getAttribute('aria-label') } : null,
  };
}

// Records evidence when `action` fails, then rethrows the original error unchanged. A failing
// recorder never masks the wait failure.
export async function withFailureEvidence(action, record) {
  try { return await action(); } catch (error) {
    try { await record(error); } catch { /* evidence is best effort */ }
    throw error;
  }
}
