import { CoreFailure } from '../../data/service';
import { OwnFailure, plainFailure } from '../../data/plain';
import { notices, type NoticeStore } from '../pages/notices';

export const updatedText = 'Updated to the latest. Try again if needed.';

export function isViewConflict(failure: unknown): boolean {
  return failure instanceof CoreFailure && !(failure instanceof OwnFailure)
    && ['revision_conflict', 'snapshot_changed', 'question_changed'].includes(failure.error.code);
}

/** A refresh changes the view only. The caller retains all draft and operation state. */
export async function conflictNotice(failure: unknown, { id, draftAtRisk, refresh, autoRefresh = refresh, store = notices, isCurrent = () => true }: {
  readonly id: string; readonly draftAtRisk: boolean; readonly refresh: () => Promise<boolean>; readonly store?: NoticeStore;
  readonly isCurrent?: () => boolean;
  readonly autoRefresh?: () => Promise<boolean>;
}): Promise<boolean> {
  if (!isViewConflict(failure)) return false;
  const refreshed = !draftAtRisk && await autoRefresh();
  if (!isCurrent()) return true;
  if (refreshed) {
    store.push({ id, icon: 'ph ph-check-circle', text: updatedText });
    return true;
  }
  store.push({ id, icon: 'ph ph-warning-circle', iconColor: 'var(--a-warn)', tone: 'problem',
    text: `${plainFailure(failure)}${draftAtRisk ? ' Your text is kept.' : ''}`, actions: [{ label: 'Refresh', run: () => {
      const notice = store.getSnapshot().find(entry => entry.id === id);
      void refresh().then(ready => {
        if (ready && isCurrent() && notice && store.getSnapshot().includes(notice)) store.dismiss(id);
      });
    } }] });
  return true;
}
