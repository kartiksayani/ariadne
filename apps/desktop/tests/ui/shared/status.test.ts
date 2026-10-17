import { describe, expect, it } from 'vitest';
import { STATUS, statusColor, statusKey } from '../../../src/ui/shared/status';
import { graphStatus, statusVisual } from '../../../src/ui/graph/model';
import { topicCounts } from '../../../src/ui/tree/model';

describe('delivery status visuals', () => {
  it('shows Sent with a paper plane and Queued with the open color and hourglass', () => {
    expect(STATUS[statusKey.sent]).toEqual({ label: 'Sent', icon: 'ph ph-paper-plane-tilt' });
    expect(STATUS[statusKey.queued]).toEqual({ label: 'Queued', icon: 'ph ph-hourglass-medium' });
    expect(statusColor(statusKey.sent)).toBe('var(--st-agent)');
    expect(statusColor(statusKey.queued)).toBe('var(--st-open)');
    expect(statusVisual[graphStatus('sent')]).toEqual(STATUS.agent);
    expect(statusVisual[graphStatus('queued')]).toEqual(STATUS.queued);
  });
  it('counts sent and queued independently before acknowledgment and canonical statuses', () => {
    expect(topicCounts(['sent', 'queued', 'waiting_on_me', 'open', 'in_progress', 'done'], 1).map(count => count.text))
      .toEqual(['1 waiting on you', '1 sent', '1 queued', '1 to ack', '1 open', '1 in progress', '1 closed']);
  });
});
