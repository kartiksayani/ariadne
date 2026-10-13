// Short labels for paths and breadcrumbs (handoff data model `short`; ADR-0084).
// The agent sets `Topic.short` and `Item.short`; older records have none, so
// the name or question is cut at a word boundary instead.
import type { Immutable } from '../../data/session-store';
import type { Item, Session, Topic } from '../../generated/domain/models';

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

type Prefix = { count: number; next: Map<string, Prefix> };

function countPrefixes(phrases: readonly (readonly string[])[]): Prefix {
  const prefixes: Prefix = { count: 0, next: new Map() };
  for (const parts of phrases) {
    let prefix = prefixes;
    for (const word of parts) {
      let next = prefix.next.get(word);
      if (!next) { next = { count: 0, next: new Map() }; prefix.next.set(word, next); }
      ++next.count; prefix = next;
    }
  }
  return prefixes;
}

/** Keep unique words ahead of long openings shared by the whole group or a subgroup. */
function distinguishingWords(texts: readonly string[]): readonly (string | null)[] {
  const words = texts.map(text => text.trim().split(/\s+/).map(word => word.replace(/^[,.;:!?·…–—-]+|[,.;:!?·…–—-]+$/g, '')));
  let start = 0, end = 0;
  while (words.every(parts => start < parts.length && parts[start] === words[0]![start])) ++start;
  while (words.every(parts => parts.length - end > start && parts[parts.length - end - 1] === words[0]![words[0]!.length - end - 1])) ++end;
  const differences = words.map(parts => parts.slice(start, parts.length - end));
  const prefixes = countPrefixes(differences);
  const phrases = differences.map(parts => {
    let prefix = prefixes;
    for (let count = 1; count <= parts.length; ++count) {
      prefix = prefix.next.get(parts[count - 1]!)!;
      if (prefix.count === 1) return parts.slice(0, count);
    }
    return null;
  });
  const suffixes = countPrefixes(phrases.map(parts => parts ? [...parts].reverse() : []));
  return phrases.map(parts => {
    if (!parts) return null;
    const phrase = parts.join(' ');
    if (phrase.length <= 24) return phrase;
    let suffix = suffixes;
    for (let count = 1; count <= parts.length; ++count) {
      suffix = suffix.next.get(parts[parts.length - count]!)!;
      if (suffix.count === 1) return parts.slice(parts.length - count).join(' ');
    }
    return phrase;
  });
}

/** Keep distinguishing words first, where a narrow view can show them before truncating the label. */
export function itemLabels(items: readonly Immutable<Item>[], topics?: Immutable<Session>['topics']): ReadonlyMap<string, string> {
  const unique = [...new Map(items.map(item => [item.id, item])).values()];
  const labels = new Map(unique.map(item => [item.id, shortLabel(item)]));
  const groups = new Map<string, Immutable<Item>[]>();
  for (const item of unique) {
    const label = labels.get(item.id)!;
    const group = groups.get(label);
    if (group) group.push(item);
    else groups.set(label, [item]);
  }
  for (const [label, group] of groups) {
    if (group.length < 2) continue;
    const names = group.map(item => topics?.[item.topic_id]?.name.trim());
    if (names.every(Boolean) && new Set(names).size === group.length) {
      const topicNames = names.map(name => name!);
      const distinctions = topicNames.some(name => name.length > 24) ? distinguishingWords(topicNames) : [];
      group.forEach((item, index) => {
        const topic = topicNames[index]!;
        labels.set(item.id, `${topic.length > 24 ? distinctions[index] ?? topic : topic} · ${label}`);
      });
      continue;
    }
    const distinctions = distinguishingWords(group.map(item => item.question));
    group.forEach((item, index) => {
      const distinction = distinctions[index];
      labels.set(item.id, distinction ? `${distinction} · ${label}` : `${item.question.trim()}${names[index] ? ` · ${names[index]}` : ''}`);
    });
  }
  return labels;
}
