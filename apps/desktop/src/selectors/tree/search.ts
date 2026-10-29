// Search in place (SPEC §6.9): which items and fields hold every word of the search, and where the hits fall in a text.
// Search never filters: the Map's rows are the same with or without it (ui/tree/model.ts), so nothing here decides rows.
// No imports: Markdown text (ui/shared) marks its hits with these too.

export const normalizeSearch = (text: string): string => text.normalize('NFKC').toLowerCase();

export type MatchField = 'question' | 'outcome' | 'note';
/** One match: an item's question, its outcome or its note holds every word of the search. */
export interface MapMatch { readonly id: string; readonly field: MatchField }

/** The search as normalised words; none while the search is empty. */
export const searchTerms = (query: string): readonly string[] => normalizeSearch(query).split(/\s+/u).filter(Boolean);

/** Whether `text` holds every word. */
export function holdsTerms(text: string | null | undefined, terms: readonly string[]): boolean {
  if (!text || !terms.length) return false;
  const lower = normalizeSearch(text);
  return terms.every(term => lower.includes(term));
}

export interface Segment { readonly text: string; readonly hit: boolean }
/** `text` split into search hits and the rest. A text NFKC lengthens or shortens is shown without hits. */
export function hitSegments(text: string, terms: readonly string[]): readonly Segment[] {
  if (!terms.length || !text) return [{ text, hit: false }];
  const lower = normalizeSearch(text), hit = new Array<boolean>(text.length).fill(false);
  if (lower.length !== text.length) return [{ text, hit: false }];
  for (const term of terms) for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) hit.fill(true, at, at + term.length);
  const out: { text: string; hit: boolean }[] = [];
  for (let index = 0; index < text.length; index++) {
    const last = out.at(-1);
    if (last && last.hit === hit[index]) last.text += text[index]; else out.push({ text: text[index]!, hit: hit[index]! });
  }
  return out;
}

const plural = (count: number, one: string, many: string) => count === 1 ? one : many;
/** "Also matching: 1 in a hidden item, 4 inside collapsed items, 2 outside the focus." or null when every match shows. */
export function alsoMatching(hidden: number, collapsed: number, outsideFocus = 0): string | null {
  const parts = [hidden ? `${hidden} ${plural(hidden, 'in a hidden item', 'in hidden items')}` : '',
    collapsed ? `${collapsed} ${plural(collapsed, 'inside a collapsed item', 'inside collapsed items')}` : '',
    outsideFocus ? `${outsideFocus} outside the focus` : ''].filter(Boolean);
  return parts.length ? `Also matching: ${parts.join(', ')}.` : null;
}

/** "2 of 4" or "No matches". */
export const matchCount = (index: number, total: number): string => total ? `${index + 1} of ${total}` : 'No matches';
