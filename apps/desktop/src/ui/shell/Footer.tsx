import { footerKeysFor, type ConversationFooterState } from './model';

export function Footer({ summary, conversation }: { readonly summary: string; readonly conversation?: ConversationFooterState }) {
  return <footer className="shell-footer">
    {footerKeysFor(conversation).map(key => <span key={key.k} className="shell-key"><span className="pw-keycap">{key.k}</span>{key.t}</span>)}
    <span className="shell-summary">{summary}</span>
  </footer>;
}
