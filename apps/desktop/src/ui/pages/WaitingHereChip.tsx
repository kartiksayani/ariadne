import type { WaitingHereChipProps } from './page-types';
import '../topbar/topbar.css';

/** The top bar's "2 waiting in this session" pill on a page: it takes me back to the session, to the first waiting question (SPEC 2.1, 5.14). */
export function WaitingHereChip({ count, narrow, onGo }: WaitingHereChipProps) {
  const words = `${count} waiting ${narrow ? 'here' : 'in this session'}`;
  return <button type="button" className="tb-here" title="Go back to the session and answer them" onClick={onGo}>
    <i className="ph-fill ph-question" aria-hidden="true" />{words}
  </button>;
}
