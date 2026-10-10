/** Current shortcut hints in the handoff's shared footer. */
export function footerChrome(source: string): string {
  return source
    .replace("{ k: 'a', t: 'answer' }", "{ k: 'a', t: 'ack / answer' }")
    .replace("{ k: '1–9', t: 'choose' }", "{ k: '1–9', t: 'select' }, { k: '⌥1–9', t: 'send choice + note' }, { k: '⌥0', t: 'focus own words' }, { k: '⌘↵', t: 'reply only' }")
    .replace("{ k: 'b r d z o', t: 'item actions' }, { k: '/', t: 'search' }", "{ k: 'b r d z o', t: 'item actions' }, { k: 'x', t: 'hide / unhide' }, { k: '/', t: 'search' }")
    .replace("{ k: 'm', t: 'messages' }, { k: 'esc', t: 'close' }", "{ k: 'm', t: 'messages' }, { k: 'w', t: 'waiting' }, { k: 'esc', t: 'close' }");
}
