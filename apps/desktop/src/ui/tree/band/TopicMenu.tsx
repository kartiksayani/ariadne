import type { ReactNode } from 'react';
import { ActionMenu } from '../../shared/ActionMenu';

interface Entry {
  readonly icon: string;
  readonly label: string;
  readonly detail: string;
  readonly run: () => void;
  readonly disabled?: boolean;
  /** Why it is greyed. */
  readonly title?: string;
  readonly danger?: boolean;
}

/**
 * The band's "…" menu (D12, SPEC 10.12): Reply to topic, Open the bin, Archive topic… and Remove topic….
 * "Continue here" (pull) is not offered. Each entry runs today's action.
 */
export function TopicMenu({ topicName, reply, bin, archive, remove, dismissKey }: {
  readonly topicName: string;
  /** Null when the topic takes no reply at all (the archive view). */
  readonly reply: { readonly run: () => void; readonly unavailable: string | null } | null;
  /** Removed work held in this topic; the bin opens in the Map, held where it is. */
  readonly bin: { readonly count: number; readonly open: () => void };
  readonly archive: () => void;
  readonly remove: { readonly run: () => void; readonly items: number };
  readonly dismissKey?: string;
}) {
  const row = (entry: Entry, close: (restoreFocus?: boolean) => void): ReactNode => <button key={entry.label} type="button" role="menuitem"
    className="tree-menu-row" data-danger={entry.danger || undefined} disabled={entry.disabled}
    title={entry.disabled && entry.title ? entry.title : undefined} onClick={() => { close(); entry.run(); }}>
    <i className={`${entry.icon} tree-menu-icon`} aria-hidden="true" /><span className="tree-menu-label">{entry.label}</span>
    <span className="tree-menu-detail">{entry.detail}</span>
  </button>;
  const label = `More actions for “${topicName}”`;
  return <ActionMenu label={label} title="Reply to topic, the bin, archive, remove" align="end" dismissKey={dismissKey}
    className="tree-band-menu-host" buttonClassName="tree-band-menu" icon={<i className="ph ph-dots-three" aria-hidden="true" />}>
    {close => <>
      {reply && row({ icon: 'ph ph-chat-text', label: 'Reply to topic', detail: 'Write to the agent about the whole topic, in Details', run: reply.run,
        disabled: !!reply.unavailable, title: reply.unavailable ? `Reply to topic: ${reply.unavailable}` : undefined }, close)}
      {reply && <div className="tree-menu-divider" role="separator" />}
      {row({ icon: 'ph ph-trash', label: 'Open the bin', detail: bin.count ? `${bin.count} removed · Restore or empty` : 'Nothing in the bin',
        run: bin.open, disabled: bin.count === 0, title: 'Nothing in the bin' }, close)}
      <div className="tree-menu-divider" role="separator" />
      {row({ icon: 'ph ph-archive', label: 'Archive topic…', detail: 'Out of the Map and Waiting on me; restore it from Archive', run: archive }, close)}
      {row({ icon: 'ph ph-trash', label: 'Remove topic…', detail: `It and its ${remove.items} item${remove.items === 1 ? '' : 's'}, with 5 seconds to undo`,
        run: remove.run, danger: true }, close)}
    </>}
  </ActionMenu>;
}
