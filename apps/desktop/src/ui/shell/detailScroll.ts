// ⌥↑ / ⌥↓ scroll the Details panel (or the bigger conversation view's body) while the arrows keep walking the Map.
//
// A tap moves about a ninth of the panel's visible height, eased in and out (the owner asked for 10% at most). Holding the
// keys scrolls on at a slow constant speed, driven frame by frame, until the keys come up, the window loses focus or the owner
// scrolls some other way. Speed is one velocity that ramps up and down, so a tap and a hold are the same motion: a tap is a
// hold that is let go early and still carries on to its distance. OS key-repeat keydowns are ignored by the caller.
const BODY = '.detail-body';
const UNREACHABLE = '[inert],[aria-hidden="true"]';
/** A tap's distance, as a share of the visible height. Kept under 10% so ending the ease never overshoots it. */
const TAP = 0.09;
/** The speed of a hold, in visible heights per second (10% per 200 ms). */
const SPEED = 0.5;
/** Seconds to reach the full speed, and to come to rest from it. */
const RAMP = 0.12;
/** The longest frame gap counted, so a stalled frame never jumps. */
const MAX_FRAME = 0.05;
/** A scroll position this far from where this module left it means the owner scrolled some other way. */
const MOVED_AWAY = 2;

export type ScrollDirection = 'up' | 'down';

/** The scroller of what Details shows: the bigger view's body when it is open, else the Details column's. Null when neither is reachable. */
export function detailBody(page: ParentNode = document): HTMLElement | null {
  const reachable = (body: HTMLElement) => !body.closest(UNREACHABLE);
  const bigger = [...page.querySelectorAll<HTMLElement>(`.item-conversation ${BODY}`)].find(reachable);
  return bigger ?? [...page.querySelectorAll<HTMLElement>(BODY)].find(reachable) ?? null;
}

interface Run {
  readonly body: HTMLElement;
  readonly direction: ScrollDirection;
  /** The arrow that started it; its key-up lets go. */
  readonly key: string;
  keyDown: boolean;
  /** Pixels per second, unsigned. */
  speed: number;
  traveled: number;
  /** Where this module last put the scroll position, kept as a fraction so slow frames do not round away. */
  position: number;
  last: number | null;
  frame: number;
}

let run: Run | null = null;

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const letGo = (event: KeyboardEvent) => { if (run && (event.key === run.key || event.key === 'Alt')) run.keyDown = false; };

/** Ends any scroll in progress where it stands. */
export function stopDetailScroll(): void {
  if (!run) return;
  cancelAnimationFrame(run.frame);
  window.removeEventListener('keyup', letGo, true);
  window.removeEventListener('blur', stopDetailScroll);
  document.removeEventListener('focusin', focusMoved, true);
  run = null;
}

/** Focus moving into a text field (or a menu) hands the keys back to it. */
function focusMoved(event: FocusEvent) {
  if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="menu"]')) stopDetailScroll();
}

function frame(now: number) {
  const current = run;
  if (!current) return;
  const { body } = current;
  if (!body.isConnected || Math.abs(body.scrollTop - current.position) > MOVED_AWAY) { stopDetailScroll(); return; }
  const gap = current.last === null ? 0 : Math.min((now - current.last) / 1000, MAX_FRAME);
  current.last = now;
  const height = Math.max(1, body.clientHeight), top = SPEED * height, accel = top / RAMP;
  const remaining = TAP * height - current.traveled, braking = current.speed * current.speed / (2 * accel);
  // Keep speeding up while the keys are down, or while a tap has more distance to go than it takes to stop; otherwise slow down.
  const drive = current.keyDown || remaining > braking;
  current.speed = drive ? Math.min(top, current.speed + accel * gap) : Math.max(0, current.speed - accel * gap);
  // A tap let go before its distance is covered slows so as to stop exactly on it, however long a frame was.
  const finishing = !current.keyDown && remaining > 0;
  if (finishing) current.speed = Math.min(current.speed, Math.sqrt(2 * accel * remaining));
  const step = finishing ? Math.min(current.speed * gap, remaining) : current.speed * gap;
  const wanted = current.position + (current.direction === 'up' ? -1 : 1) * step;
  const reached = Math.min(Math.max(0, body.scrollHeight - height), Math.max(0, wanted));
  current.traveled += Math.abs(reached - current.position);
  current.position = reached;
  body.scrollTop = reached;
  if (reached !== wanted || (!drive && current.speed === 0) || finishing && remaining - step <= 0.5) { stopDetailScroll(); return; }
  current.frame = requestAnimationFrame(frame);
}

/**
 * Starts scrolling Details by the key press `event` (a first press, not a key-repeat). True when there is a panel to scroll.
 * A press while one is running replaces it.
 */
export function startDetailScroll(direction: ScrollDirection, event: Pick<KeyboardEvent, 'key'>, page: ParentNode = document): boolean {
  const body = detailBody(page);
  if (!body) return false;
  stopDetailScroll();
  if (reducedMotion()) {
    const step = Math.round(TAP * Math.max(1, body.clientHeight));
    body.scrollTop += direction === 'up' ? -step : step;
    return true;
  }
  run = { body, direction, key: event.key, keyDown: true, speed: 0, traveled: 0, position: body.scrollTop, last: null, frame: 0 };
  window.addEventListener('keyup', letGo, true);
  window.addEventListener('blur', stopDetailScroll);
  document.addEventListener('focusin', focusMoved, true);
  run.frame = requestAnimationFrame(frame);
  return true;
}

/** Whether a scroll started by `direction`'s arrow is still running, so its key-repeat presses can be swallowed. */
export function scrollingDetails(direction: ScrollDirection): boolean {
  return run?.direction === direction && run.keyDown;
}
