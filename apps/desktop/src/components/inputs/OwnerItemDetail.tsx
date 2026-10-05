import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { ItemDetail } from '../history/ItemDetail';
import { OwnerInput, type OwnerFocusRequest } from './OwnerInput';
import type { OwnerDraftStore, OwnerIntent } from '../../state/drafts/store';

export function OwnerItemDetail({ drafts, later, onLater, focusRequest, ...props }: Omit<ComponentProps<typeof ItemDetail>, 'onIntent'> & {
  drafts: OwnerDraftStore; focusRequest?: OwnerFocusRequest; later?: boolean; onLater?: (value: boolean) => Promise<boolean>;
}) {
  const [intent, setIntent] = useState<OwnerIntent>('answer'), editor = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focusRequest) setIntent(focusRequest.intent); }, [focusRequest]);
  useEffect(() => { editor.current?.querySelector('textarea')?.focus(); }, [intent]);
  return <>
    <ItemDetail {...props} onIntent={next => { setIntent(next); }} />
    {props.itemId && <div ref={editor}><OwnerInput key={`${props.itemId}:${intent}`} drafts={drafts} session={props.store}
      itemId={props.itemId} initialIntent={intent} focusRequest={focusRequest} later={later} onLater={onLater} onEscape={props.onClose} /></div>}
  </>;
}
