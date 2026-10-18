// The Map's place while the session can't be read at all (SPEC 12.7): no rows exist to draw, so the panel says so and offers
// the failure's words to copy. The line above the Map carries the state and the "Try again".
import { OutlineButton, copyIcon, copyLabel, useCopy } from '../parts/parts';
import { copyText } from '../shared/clipboard';

export function UnreadableMap({ error }: { readonly error: string | null }) {
  const [copied, copy] = useCopy();
  return <div className="tree-unreadable" role="status">
    <i className="ph ph-file-code" aria-hidden="true" />
    <div className="tree-unreadable-title">No Map to show</div>
    <p>The Map comes back as soon as this session’s file can be read. Drafts and answers in other sessions aren’t affected.</p>
    {error && <OutlineButton icon={copyIcon(copied)} onClick={() => { copy(() => copyText(error).then(() => true, () => false)); }}>{copyLabel(copied, 'Copy the error')}</OutlineButton>}
  </div>;
}
