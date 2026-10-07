// Failure evidence for history waits. Runs in the WebView via browser.execute, so it must stay
// self-contained and read only DOM facts the product already renders.
export function historyFailureFacts() {
  const text = node => node?.textContent?.trim() ?? null;
  const all = selector => [...document.querySelectorAll(selector)];
  const control = node => node ? { text: text(node), disabled: Boolean(node.disabled), ariaPressed: node.getAttribute('aria-pressed') } : null;
  const titled = document.querySelector('button[title="Messages (m)"]');
  const owner = document.querySelector('.owner-input');
  const editor = owner?.querySelector('textarea') ?? null;
  const send = owner?.querySelector('.answer-send-row button') ?? null;
  const search = document.querySelector('[data-shell-search]');
  const stateButtons = /^(Refresh|Refreshing…|Reconcile operation|Register project|Connect existing session|Retry saving draft preferences|Retry saved input|Write another input)$/;
  const active = document.activeElement;
  return {
    // Messages (m) is an icon-only button: the spec selects it by title and it is named by aria-label.
    messagesToggle: { titled: control(titled), ariaLabel: titled?.getAttribute('aria-label') ?? null,
      railOpen: Boolean(document.querySelector('.rail-messages')), railMessageCount: all('.rail-messages [data-message-id]').length },
    // chromeDisabled follows writing / refreshPending / missing preferences; these labels expose that state.
    navigation: { banners: all('.nav-banner').map(node => ({ role: node.getAttribute('role'), text: text(node) })),
      alerts: all('[role="alert"]').map(text), statuses: all('[role="status"]').map(text),
      stateButtons: all('button').filter(button => stateButtons.test(text(button) ?? '')).map(control),
      disabledHeaderButtons: all('.shell-header button').filter(button => button.disabled).map(button => button.title || text(button)) },
    search: { present: Boolean(search), disabled: search ? search.disabled : null, value: search?.value ?? null,
      statusLabel: all('[role="status"]').map(text).find(label => label?.startsWith('Search preview')) ?? null },
    selected: { treeItemIds: all('[data-item-id][aria-selected="true"], [data-item-id][aria-current]').map(node => node.getAttribute('data-item-id')),
      detailHeader: text(document.querySelector('.item-history > .history-header > strong')),
      detailQuestion: text(document.querySelector('.item-history > h2')),
      sourceRounds: all('.item-history > .history-meta').map(text) },
    ownerInput: { present: Boolean(owner), label: owner?.getAttribute('aria-label') ?? null,
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
