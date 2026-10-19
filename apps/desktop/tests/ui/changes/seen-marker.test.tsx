// The transient Seen pill (SPEC 3.7, 9.10): a check and "Seen", a title that says where the dwell cleared it, no diamond form.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ChangeMarker } from '../../../src/ui/changes/ChangeMarker';

afterEach(cleanup);

describe('ChangeMarker seen', () => {
  it.each([
    [undefined, 'Marked seen after a second'],
    ['details' as const, 'Marked seen after a second in Details'],
    ['dock' as const, 'Marked seen after a second in the dock'],
  ])('titles the Seen pill for %s', (seenWhere, title) => {
    render(<ChangeMarker kind="seen" seenWhere={seenWhere} />);
    const marker = screen.getByRole('img', { name: 'Seen' });
    expect(marker.getAttribute('title')).toBe(title);
    expect(marker.getAttribute('data-kind')).toBe('seen');
    expect(marker.textContent).toBe('Seen');
    expect(marker.querySelector('svg')).not.toBeNull();
    expect(marker.querySelector('i')).toBeNull();
  });

  it('is always a pill, even when the diamond is asked for', () => {
    render(<ChangeMarker kind="seen" form="diamond" />);
    expect(screen.getByRole('img', { name: 'Seen' }).getAttribute('data-form')).toBe('pill');
  });

  it('leaves New and Changed as they were', () => {
    render(<><ChangeMarker kind="new" /><ChangeMarker kind="changed" form="diamond" /></>);
    expect(screen.getByRole('img', { name: 'New' }).getAttribute('title')).toBe('New: you haven’t seen this item yet');
    expect(screen.getByRole('img', { name: 'Changed' }).getAttribute('data-form')).toBe('diamond');
  });
});
