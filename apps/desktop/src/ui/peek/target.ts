import type { ItemRoute } from '../../generated/core';

/** Names the item a peek card shows (`data-peek-target` on the card), so keys can tell whether a card is about the item they would act on. */
export const peekTargetKey = (route: ItemRoute): string => JSON.stringify([route.project_id, route.session_id, route.item_id]);
