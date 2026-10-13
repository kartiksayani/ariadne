import type { Immutable } from '../../data/session-store';
import type { Session } from '../../generated/domain/models';
import type { ChangeCard, ChangeRow } from '../../selectors/changes/card';
import { changeRow } from '../../selectors/changes/card';
import { activeItems } from '../../selectors/removed';

export interface CardGroup { readonly label: string; readonly rows: readonly ChangeRow[] }
export interface LimitedGroups {
  readonly shown: readonly CardGroup[];
  readonly hidden: readonly CardGroup[];
  readonly withinGroup: CardGroup | null;
  readonly summary: string;
}

/** Keep groups whole, except an oversized first group; never hide one name. */
export function limitGroups(groups: readonly CardGroup[], expanded = false, withinGroupExpanded = false): LimitedGroups {
  const nonempty = groups.filter(group => group.rows.length);
  const shown: CardGroup[] = [], hidden: CardGroup[] = [];
  let count = 0, stopped = false, withinGroup: CardGroup | null = null;
  for (const group of nonempty) {
    if (!stopped && count + group.rows.length <= 5) {
      shown.push(group);
      count += group.rows.length;
    } else if (!shown.length) {
      shown.push({ label: group.label, rows: group.rows.slice(0, 5) });
      withinGroup = { label: group.label, rows: group.rows.slice(5) };
      stopped = true;
    } else {
      hidden.push(group);
      stopped = true;
    }
  }
  const remaining = hidden.reduce((sum, group) => sum + group.rows.length, 0);
  if (remaining + (withinGroup?.rows.length ?? 0) === 1) return { shown: nonempty, hidden: [], withinGroup: null, summary: '' };
  const displayed = withinGroupExpanded && withinGroup ? nonempty.slice(0, 1) : shown;
  return {
    shown: expanded ? [...displayed, ...hidden] : displayed,
    hidden: expanded ? [] : hidden,
    withinGroup: withinGroupExpanded ? null : withinGroup,
    summary: !expanded && remaining ? `and ${remaining} more: ${hidden.map(group => `${group.rows.length} ${group.label.toLowerCase()}`).join(', ')}` : '',
  };
}

const settled = (status: string | null | undefined) => status == null || ['done', 'decided', 'dropped'].includes(status);

/** Compare declared dependencies with their state before this answer's batches. */
export function newlyBlocked(session: Immutable<Session>, card: ChangeCard): ReadonlySet<string> {
  const changed = [...card.groups.updated, ...card.groups.replaced, ...card.groups.new];
  const changedById = new Map(changed.map(row => [row.item.id, row]));
  const created = new Set(card.groups.new.map(row => row.item.id));
  const affected = new Set(changed.flatMap(row => row.item.affects ?? []));
  const result = new Set<string>();
  for (const item of activeItems(session)) {
    if (['done', 'decided', 'dropped', 'replaced'].includes(item.status)) continue;
    if (!changedById.has(item.id) && !affected.has(item.id) && !item.depends_on?.some(id => changedById.has(id))) continue;
    const blocked = (item.depends_on ?? []).some(id => !settled(session.items[id]?.status));
    if (!blocked) continue;
    const oldLinks = changedById.get(item.id)?.fields.find(field => field.field === 'depends_on');
    const beforeLinks = created.has(item.id) ? [] : oldLinks ? (Array.isArray(oldLinks.before) ? oldLinks.before.filter((id): id is string => typeof id === 'string') : []) : item.depends_on ?? [];
    const wasBlocked = beforeLinks.some(id => {
      if (created.has(id)) return false;
      const oldStatus = changedById.get(id)?.fields.find(field => field.field === 'status');
      return !settled(oldStatus ? oldStatus.before as string | null : session.items[id]?.status);
    });
    if (!wasBlocked) result.add(item.id);
  }
  return result;
}

export function answerGroups(session: Immutable<Session>, card: ChangeCard, blocked = newlyBlocked(session, card)): readonly CardGroup[] {
  const changedIds = new Set([...card.groups.updated, ...card.groups.replaced, ...card.groups.new].map(row => row.item.id));
  const rows = activeItems(session).filter(item => blocked.has(item.id) && !changedIds.has(item.id));
  return [{ label: 'Updated', rows: card.groups.updated }, { label: 'Replaced', rows: card.groups.replaced },
    { label: 'New', rows: card.groups.new }, { label: 'Now blocked', rows: rows.map(item => changeRow(session, item, [])) }];
}

export function readAs(session: Immutable<Session>, card: ChangeCard): readonly string[] {
  const attempts = session.inputs[card.inputId]?.attempts ?? [];
  const batchAttempts = new Set(card.batches.map(batch => batch.message.attempt_id).filter(Boolean));
  return [...new Set(attempts.filter(attempt => !batchAttempts.size || batchAttempts.has(attempt.id))
    .flatMap(attempt => attempt.domain_result?.explanation.startsWith('Read as:') ? [attempt.domain_result.explanation] : []))];
}

export function causeLabel(session: Immutable<Session>, inputId: string): string {
  const answer = session.answers.find(value => value.input_id === inputId);
  const input = session.inputs[inputId];
  const option = answer?.options_snapshot.find(value => value.id === answer.selected_option_id)
    ?? input?.payload.target_snapshot.options.find(value => value.id === input.payload.selected_option_id);
  return option ? `Changed when you chose ${option.label} ↗` : 'Changed after your typed answer ↗';
}
