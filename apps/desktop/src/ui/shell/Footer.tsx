import { footerKeys } from './model';

export function Footer({ summary }: { readonly summary: string }) {
  return <footer className="shell-footer">
    {footerKeys.map(key => <span key={key.k} className="shell-key"><span className="pw-keycap">{key.k}</span>{key.t}</span>)}
    <span className="shell-summary">{summary}</span>
  </footer>;
}
