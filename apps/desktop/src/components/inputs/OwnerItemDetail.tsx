import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { ItemDetail } from '../history/ItemDetail';
import { OwnerInput, type OwnerFocusRequest } from './OwnerInput';
import { useOwnerDrafts, type OwnerDraftStore, type OwnerIntent } from '../../state/drafts/store';

export function OwnerItemDetail({ drafts, later, onLater, focusRequest, onFocusRequestConsumed, ...props }: Omit<ComponentProps<typeof ItemDetail>, 'onIntent'> & {
  drafts: OwnerDraftStore; focusRequest?: OwnerFocusRequest; onFocusRequestConsumed?: (token: number) => void; later?: boolean; onLater?: (value: boolean) => Promise<boolean>;
}) {
  const [choice, setChoice] = useState<{ intent: OwnerIntent; focusRequest: number }>({ intent: 'answer', focusRequest: 0 });
  const editor = useRef<HTMLDivElement>(null), focusedRequest = useRef(0), draftState = useOwnerDrafts(drafts);
  useEffect(() => { if (focusRequest) setChoice(previous => ({ ...previous, intent: focusRequest.intent })); }, [focusRequest]);
  useEffect(() => {
    if (choice.focusRequest === focusedRequest.current) return;
    const textarea = editor.current?.querySelector('textarea');
    if (!textarea) return;
    textarea.focus(); focusedRequest.current = choice.focusRequest;
  }, [choice, draftState]);
  return <>
    <ItemDetail {...props} onIntent={next => { setChoice(previous => ({ intent: next, focusRequest: previous.focusRequest + 1 })); }} />
    {props.itemId && <div ref={editor}><OwnerInput key={`${props.itemId}:${choice.intent}`} drafts={drafts} session={props.store}
      itemId={props.itemId} initialIntent={choice.intent} focusRequest={focusRequest?.intent === choice.intent ? focusRequest : undefined}
      onFocusRequestConsumed={onFocusRequestConsumed} later={later} onLater={onLater} onEscape={props.onClose} /></div>}
  </>;
}
