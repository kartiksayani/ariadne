import type { SessionRef } from '../../generated/core';
import type { Immutable } from '../../data/session-store';
import type { Item } from '../../generated/domain/models';
import { usePeek } from '../peek/context';
import { shortLabel } from '../shared/short';

/** An item's name as a button: a click opens the item, hovering peeks it. Peeking never changes what the owner has seen. */
export function ItemName({ item, route, label, onOpen }: {
  readonly item: Immutable<Item>; readonly route?: SessionRef | null; readonly label?: string; readonly onOpen: (id: string) => void;
}) {
  const peek = usePeek();
  const hover = peek && route ? peek.hoverProps({ ...route, item_id: item.id }) : {};
  return <button type="button" className="change-name" title={item.question} {...hover} onClick={() => onOpen(item.id)}>{label ?? shortLabel(item)}</button>;
}
