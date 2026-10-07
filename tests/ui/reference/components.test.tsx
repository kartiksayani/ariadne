import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { STATUS, StatusBadge } from '../../../apps/desktop/src/components/reference/StatusBadge';

afterEach(cleanup);

describe('source presentation primitives', () => {
  it('renders every source status label, regular/fill icon and badge variant', () => {
    for (const status of Object.keys(STATUS) as (keyof typeof STATUS)[]) {
      const { container, unmount } = render(<><StatusBadge status={status} /><StatusBadge status={status} variant="text" /><StatusBadge status={status} variant="icon" /></>);
      expect(screen.getAllByText(STATUS[status].label)).toHaveLength(2);
      expect(screen.getByRole('img').className).toBe(STATUS[status].icon);
      expect(container.querySelectorAll('i')).toHaveLength(2);
      unmount();
    }
    render(<StatusBadge status="open" label="Later" variant="icon" size={20} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Later');
    expect(screen.getByRole('img').style.fontSize).toBe('20px');
  });
});
