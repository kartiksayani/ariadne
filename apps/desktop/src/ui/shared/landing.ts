// Landing (alpha.24 P3, P5): when the app takes the owner to an item (⌘[ / ⌘], the swipe that does the same, `n`), the Map or the
// Graph moves there fast and eased instead of jumping, and stops exactly where the jump would have. Every frame measures again how
// far the target still is, so rows that change height on the way and the reading-row hold's own corrections are absorbed, never
// overshot. A long way jumps all but the last screen at once and eases over that screen. Reduced motion jumps, as does a page that
// cannot ask for it (jsdom has no matchMedia).
import { SWIPE_DOMINANCE, SWIPE_GAP_MS } from '../shell/swipeGesture';

/** How long a landing takes, in ms. */
export const LANDING_MS = 300;

/** Whether a landing may move: not under reduced motion, nor where no media query can be asked. */
export function landingMoves(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A distance on both axes, in pixels: `top` down, `left` right. */
export interface Offset { readonly top: number; readonly left: number }

export interface LandingSteps {
  /** How far the scroller still is from where the jump would put it; null once the target is gone (the landing stops where it is). */
  readonly remaining: () => Offset | null;
  /** Moves the scroller by `by`. */
  readonly move: (by: Offset) => void;
  /** The scroller's visible size: a longer way jumps to this far from the target first. */
  readonly screen: () => Offset;
  /** The landing arrived. Never called for one that was cancelled or whose target went. */
  readonly landed: () => void;
}

export interface Landing {
  /** Stops the landing where it is. */
  readonly cancel: () => void;
  readonly running: () => boolean;
}

/**
 * `offset` cut to what `box` can still scroll. A target whose place lies past the end of the scroll range (a node near the edge that
 * cannot be centred, a row at the very end) is reached at the end, as the jump reaches it; without the cut a landing would ease
 * toward a place it cannot get to and stop dead against the end at full speed.
 */
export function reachable(box: Element, offset: Offset): Offset {
  const limit = (by: number, scrolled: number, room: number) => Math.min(Math.max(by, -scrolled), Math.max(0, room - scrolled));
  return { top: limit(offset.top, box.scrollTop, box.scrollHeight - box.clientHeight), left: limit(offset.left, box.scrollLeft, box.scrollWidth - box.clientWidth) };
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;
/** Under half a pixel on both axes. */
const there = (offset: Offset) => Math.abs(offset.top) < 0.5 && Math.abs(offset.left) < 0.5;
/** The part of `value` beyond one `screen`, which is jumped at once. */
const beyond = (value: number, screen: number) => Math.abs(value) > screen ? value - Math.sign(value) * screen : 0;

/** Starts a landing. Its first frame comes on the next animation frame; one with no way to go lands at once. */
export function startLanding(steps: LandingSteps): Landing {
  let live = true, frame = 0, eased = 0;
  const landing: Landing = { cancel: () => { if (live) { live = false; cancelAnimationFrame(frame); } }, running: () => live };
  const first = steps.remaining();
  if (!first) { live = false; return landing; }
  if (there(first)) { live = false; steps.landed(); return landing; }
  const screen = steps.screen(), jump = { top: beyond(first.top, screen.top), left: beyond(first.left, screen.left) };
  if (jump.top || jump.left) steps.move(jump);
  const begin = performance.now();
  const tick = () => {
    if (!live) return;
    const left = steps.remaining();
    if (!left) { live = false; return; }
    const t = Math.min(1, Math.max(0, (performance.now() - begin) / LANDING_MS));
    if (t >= 1 || there(left)) {
      if (left.top || left.left) steps.move(left);
      live = false; steps.landed(); return;
    }
    // This frame's share of what is left: the eased curve when nothing changed on the way, and what changed is taken up as it goes.
    const next = easeOut(t), share = (next - eased) / (1 - eased);
    eased = next;
    if (share > 0) steps.move({ top: left.top * share, left: left.left * share });
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return landing;
}

const MODIFIERS: ReadonlySet<string> = new Set(['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn']);
/** Whether a key press is the owner's input that stops a landing: not a held key's repeat, nor a bare modifier (the ⌘ of the next ⌘[). */
export function keyStopsLanding(event: Pick<KeyboardEvent, 'key' | 'repeat'>): boolean {
  return !event.repeat && !MODIFIERS.has(event.key);
}

/** Whether a wheel is the owner scrolling `box` now: up or down, or across where it can still go that way. */
export function wheelScrolls(event: Pick<WheelEvent, 'deltaX' | 'deltaY'>, box: Element): boolean {
  if (Math.abs(event.deltaY) >= Math.abs(event.deltaX)) return event.deltaY !== 0;
  return event.deltaX < 0 ? box.scrollLeft > 0 : box.scrollLeft + box.clientWidth < box.scrollWidth - 1;
}

/**
 * The wheel events over a view, grouped into streams (a quiet SWIPE_GAP_MS ends one, as for the swipe). A sideways stream that was
 * running when a landing began is the swipe that started it, trailing momentum included: the landing moving the Graph sideways
 * must not make the next event of that stream look like a scroll (`wheelScrolls` reads the box as it is now). It stops for the
 * owner's own wheel: a new stream, or one that is not mostly sideways.
 */
export class WheelStream {
  private streams = 0;
  private carried = -1;
  private last = Number.NEGATIVE_INFINITY;
  private along = 0;
  private across = 0;

  /** A landing has just begun: the stream running now (if any) is the one that started it. Call this wherever a landing starts. */
  carry(): void { this.carried = this.streams; }

  /**
   * Whether this wheel stops a running landing: it is the owner scrolling `box`, and not the sideways stream the landing began in.
   * Call it for every wheel over the view, a landing running or not (the swipe's own events come before its landing begins).
   */
  stops(event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'timeStamp'>, box: Element): boolean {
    if (event.timeStamp - this.last > SWIPE_GAP_MS) { ++this.streams; this.along = 0; this.across = 0; }
    this.last = event.timeStamp;
    this.along += Math.abs(event.deltaX); this.across += Math.abs(event.deltaY);
    if (this.streams === this.carried && this.along > SWIPE_DOMINANCE * this.across) return false;
    return wheelScrolls(event, box);
  }
}
