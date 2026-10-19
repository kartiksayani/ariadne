// The archive strip from the owner's own archive receipt (alpha.22 E12): it stands from the render the topic goes in, until
// the lifecycle keeps it, and never comes back once kept.
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Immutable } from '../../../src/data';
import type { MutationReceipt } from '../../../src/generated/core';
import type { Session } from '../../../src/generated/domain/models';
import { useArchiveBridge, type ArchiveAction } from '../../../src/ui/tree/archiveBridge';
import type { Archived } from '../../../src/ui/shared/useSessionLifecycle';

const topicId = '00000000-0000-4000-8000-000000000011';
const session = (archived: boolean) => ({ topics: { [topicId]: { id: topicId, name: 'Continued context', short: null, archived_at: archived ? 5 : null } } }) as unknown as Immutable<Session>;
const receipt = (archivedAt: number | null, kind = 'topic_lifecycle') => ({ operation_id: 'op', session_id: 's', revision: 2,
  data: { kind, topic_id: topicId, topic_revision: 2, archived_at: archivedAt } }) as unknown as Immutable<MutationReceipt>;
const kept: Archived = { topicId, name: 'Continued context', waiting: 1, cancelled: 0 };
interface Props { action: ArchiveAction; archived: Archived | null; session: Immutable<Session> | null }
const bridge = (props: Props) => renderHook((value: Props) => useArchiveBridge(value.action, value.archived, value.session), { initialProps: props });

describe('the archive bridge', () => {
  it('stands for the archived topic from the receipt\'s render, the same object until the lifecycle keeps it', () => {
    const archive = receipt(5), hook = bridge({ action: { receipt: archive, error: null }, archived: null, session: session(true) });
    const first = hook.result.current;
    expect(first?.topicId).toBe(topicId);
    hook.rerender({ action: { receipt: archive, error: null }, archived: null, session: session(true) });
    expect(hook.result.current).toBe(first);
    hook.rerender({ action: { receipt: archive, error: null }, archived: kept, session: session(true) });
    expect(hook.result.current).toBe(kept);
  });

  it('bridges no more once the lifecycle has kept that receipt: an Undo, a dismissal or a switch never brings it back', () => {
    const archive = receipt(5), hook = bridge({ action: { receipt: archive, error: null }, archived: kept, session: session(true) });
    hook.rerender({ action: { receipt: archive, error: null }, archived: null, session: session(true) });
    expect(hook.result.current).toBeNull();
  });

  const none: readonly [string, Props][] = [
    ['no receipt', { action: { receipt: null, error: null }, archived: null, session: session(true) }],
    ['a restore', { action: { receipt: receipt(null), error: null }, archived: null, session: session(false) }],
    ['another kind of receipt', { action: { receipt: receipt(5, 'item_ack'), error: null }, archived: null, session: session(true) }],
    ['a failed follow-up read', { action: { receipt: receipt(5), error: new Error('read') }, archived: null, session: session(true) }],
    ['a session not yet showing it archived', { action: { receipt: receipt(5), error: null }, archived: null, session: session(false) }],
    ['no session', { action: { receipt: receipt(5), error: null }, archived: null, session: null }],
  ];
  it.each(none)('stands for nothing on %s', (_name, props) => {
    expect(bridge(props).result.current).toBeNull();
  });
});
