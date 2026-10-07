// Short labels for paths and breadcrumbs (handoff data model `short`; ADR-0084).
// The agent sets `Topic.short` and `Item.short`; older records have none, so
// the name or question is cut at a word boundary instead.
import type { Immutable } from '../../data/session-store';
import type { Item, Topic } from '../../generated/domain/models';

/**
 * The short label of a topic or item: its `short` when set, else its name or
 * question cut at a word boundary near 24 characters with "…".
 */
export function shortLabel(entity: Immutable<Topic> | Immutable<Item>): string {
  if (entity.short?.trim()) return entity.short.trim();
  const text = ('question' in entity ? entity.question : entity.name).trim();
  if (text.length <= 24) return text;
  const cut = text.slice(0, 25), space = cut.lastIndexOf(' ');
  return `${(space > 8 ? cut.slice(0, space) : cut.slice(0, 24)).replace(/[\s,.;:·–—-]+$/, '')}…`;
}
