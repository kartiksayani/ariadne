import { ItemConversation, type ItemDetailProps } from './ItemConversation';

export { DetailPath } from './DetailPath';
export type { ItemDetailProps } from './ItemConversation';

/** The pane and bigger view share the conversation, composers and per-item draft store. */
export function ItemDetail(props: ItemDetailProps) {
  return <ItemConversation {...props} />;
}
