import type { Immutable } from '../../data/session-store';
import type { Item, ItemChangeBefore, ItemChangeRecord, ItemOption, Message, Session } from '../../generated/domain/models';
import { activeItems, itemRemoved } from '../removed';

export interface ChangedField {
  readonly field: keyof ItemChangeBefore;
  readonly before: Immutable<ItemChangeBefore[keyof ItemChangeBefore]>;
  readonly current: Immutable<ItemChangeBefore[keyof ItemChangeBefore]>;
}
export interface ChangeRow {
  readonly item: Immutable<Item>;
  readonly sentence: string;
  readonly records: readonly Immutable<ItemChangeRecord>[];
  readonly fields: readonly ChangedField[];
  readonly reasons: readonly string[];
  readonly replacement: Immutable<Item> | null;
  readonly why: string | null;
}
export interface ChangeGroups {
  readonly updated: readonly ChangeRow[];
  readonly replaced: readonly ChangeRow[];
  readonly new: readonly ChangeRow[];
  readonly reworded: readonly ChangeRow[];
}
export interface InputAnswer {
  readonly question: string;
  readonly text: string;
  readonly selectedOption: Immutable<ItemOption> | null;
}
export interface ChangeBatch {
  readonly message: Immutable<Message>;
  readonly reasons: readonly string[];
}
export interface ChangeCard {
  readonly inputId: string;
  readonly answer: InputAnswer | null;
  readonly batches: readonly ChangeBatch[];
  readonly groups: ChangeGroups;
  readonly total: number;
}

export function changeRow(session: Immutable<Session>, item: Immutable<Item>,
  records: readonly Immutable<ItemChangeRecord>[]): ChangeRow {
  const previous = new Map<keyof ItemChangeBefore, Immutable<ItemChangeBefore[keyof ItemChangeBefore]>>();
  for (const record of records) for (const field of Object.keys(record.before) as (keyof ItemChangeBefore)[]) {
    if (!previous.has(field)) previous.set(field, record.before[field]);
  }
  const fields = [...previous].map(([field, before]) => Object.freeze({ field, before, current: item[field] ?? null }));
  const replacement = item.replaced_by && !itemRemoved(session, item.replaced_by) ? session.items[item.replaced_by] ?? null : null;
  return Object.freeze({ item, sentence: item.question, records: Object.freeze([...records]), fields: Object.freeze(fields),
    reasons: Object.freeze([...new Set(records.flatMap(record => record.reason ? [record.reason] : []))]), replacement, why: item.why });
}

/** A later status edit supplies the state following an older record; all displayed fields still use CURRENT. */
function becameReplaced(item: Immutable<Item>, record: Immutable<ItemChangeRecord>): boolean {
  if (!Object.prototype.hasOwnProperty.call(record.before, 'status')) return false;
  const later = (item.changes ?? []).find(change => change.revision > record.revision && Object.prototype.hasOwnProperty.call(change.before, 'status'));
  return (later ? later.before.status : item.status) === 'replaced';
}

export function groupChanges(session: Immutable<Session>, items: readonly Immutable<Item>[],
  created: (item: Immutable<Item>) => boolean, selected: (item: Immutable<Item>) => readonly Immutable<ItemChangeRecord>[]): ChangeGroups {
  const groups: { updated: ChangeRow[]; replaced: ChangeRow[]; new: ChangeRow[]; reworded: ChangeRow[] } = {
    updated: [], replaced: [], new: [], reworded: [],
  };
  for (const item of items) {
    const records = selected(item), isNew = created(item);
    if (!isNew && !records.length) continue;
    const meaningful = records.filter(record => !record.wording_only), wording = records.filter(record => record.wording_only);
    if (isNew) groups.new.push(changeRow(session, item, records));
    else {
      if (meaningful.length) {
        const row = changeRow(session, item, meaningful);
        if (meaningful.some(record => becameReplaced(item, record))) groups.replaced.push(row);
        else groups.updated.push(row);
      }
      if (wording.length) groups.reworded.push(changeRow(session, item, wording));
    }
  }
  return Object.freeze({ updated: Object.freeze(groups.updated), replaced: Object.freeze(groups.replaced),
    new: Object.freeze(groups.new), reworded: Object.freeze(groups.reworded) });
}

/** Batch provenance, not touched-item backlinks or reply text, determines what an input changed. */
export function changeCard(session: Immutable<Session>, inputId: string): ChangeCard {
  const messages = session.messages.filter(message => message.author === 'agent' && message.kind === 'activity' && message.input_id === inputId)
    .sort((left, right) => left.number - right.number);
  const causes = new Set(messages.map(message => message.id));
  const items = activeItems(session);
  const groups = groupChanges(session, items, item => causes.has(item.created_message_id),
    item => (item.changes ?? []).filter(record => causes.has(record.cause_message_id)));
  const answer = session.answers.find(value => value.input_id === inputId);
  const payload = session.inputs[inputId]?.payload;
  const inputAnswer = answer ? Object.freeze({ question: answer.question_snapshot, text: answer.text,
    selectedOption: answer.options_snapshot.find(option => option.id === answer.selected_option_id) ?? null })
    : payload ? Object.freeze({ question: payload.target_snapshot.item_question ?? payload.target_snapshot.topic_name, text: payload.text,
      selectedOption: payload.target_snapshot.options.find(option => option.id === payload.selected_option_id) ?? null }) : null;
  const batches = messages.map(message => {
    const reasons = items.flatMap(item => (item.changes ?? []).flatMap(record =>
      record.cause_message_id === message.id && record.reason ? [record.reason] : []));
    if (message.body.trim()) reasons.unshift(message.body);
    return Object.freeze({ message, reasons: Object.freeze([...new Set(reasons)]) });
  });
  return Object.freeze({ inputId, answer: inputAnswer, batches: Object.freeze(batches), groups,
    total: groups.updated.length + groups.replaced.length + groups.new.length });
}
