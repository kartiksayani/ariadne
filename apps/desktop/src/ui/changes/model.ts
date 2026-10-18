import type { Immutable } from '../../data/session-store';
import type { Item, Session } from '../../generated/domain/models';
import type { ChangeCard, ChangeRow } from '../../selectors/changes/card';
import { changeCard, changeRow } from '../../selectors/changes/card';
import { peekNames } from '../peek/names';
import { activeItems } from '../../selectors/removed';

/** What an answer did to one item, in the Because card's words (SPEC 6.8). */
export type EffectKind = 'created' | 'changed' | 'blocked';
export interface Effect { readonly kind: EffectKind; readonly row: ChangeRow; readonly note: string | null }
export interface LimitedEffects { readonly shown: readonly Effect[]; readonly more: number }

/** Five effects show; a list that would hide only one shows it too, so "and 1 more" never stands for a single name. */
export const EFFECTS_SHOWN = 5;
export function limitEffects(effects: readonly Effect[], expanded = false): LimitedEffects {
  if (expanded || effects.length <= EFFECTS_SHOWN + 1) return { shown: effects, more: 0 };
  return { shown: effects.slice(0, EFFECTS_SHOWN), more: effects.length - EFFECTS_SHOWN };
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

/** Created, then Changed (updated and replaced), then Blocked, each in Map order. Hidden-by-rewording rows are not effects. */
export function answerEffects(session: Immutable<Session>, card: ChangeCard, blocked = newlyBlocked(session, card)): readonly Effect[] {
  const changedIds = new Set([...card.groups.updated, ...card.groups.replaced, ...card.groups.new].map(row => row.item.id));
  const labels = peekNames(session);
  const waitsOn = (item: Immutable<Item>) => (item.depends_on ?? []).filter(id => !settled(session.items[id]?.status)).map(id => `“${labels.get(id) ?? session.items[id]?.question ?? id}”`);
  const created = card.groups.new.map((row): Effect => ({ kind: 'created', row, note: row.reasons[0] ?? (row.item.question !== labels.get(row.item.id) ? row.item.question : null) }));
  const changed = [...card.groups.updated, ...card.groups.replaced].map((row): Effect => ({ kind: 'changed', row, note: row.reasons[0] ?? null }));
  const stopped = activeItems(session).filter(item => blocked.has(item.id) && !changedIds.has(item.id))
    .map((item): Effect => ({ kind: 'blocked', row: changeRow(session, item, []), note: waitsOn(item).length ? `waits on ${waitsOn(item).join(', ')}` : null }));
  return [...created, ...changed, ...stopped];
}

/**
 * The newest owner message whose answer changed something: the one place the Because card shows (SPEC 5.3 item 8). The owner's
 * messages are matched to their answer by message id, as the input's own message or the answer's.
 */
export function latestChangedAnswer(session: Immutable<Session>, entries: readonly { readonly id: string; readonly you?: unknown }[]): string | null {
  const inputs = Object.values(session.inputs);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (!entry.you) continue;
    const inputId = inputs.find(value => value?.message_id === entry.id)?.id ?? session.answers.find(value => value.message_id === entry.id)?.input_id;
    if (!inputId) continue;
    const card = changeCard(session, inputId);
    if (card.total || card.groups.reworded.length) return entry.id;
  }
  return null;
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
