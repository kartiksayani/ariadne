import { useEffect } from 'react';

/** Percent of the original Paperwhite text size. */
export const TEXT_SIZES = [70, 80, 90, 100, 110, 120] as const;
export type TextSize = typeof TEXT_SIZES[number];
export type TextSizeIntent = 'text-smaller' | 'text-larger' | 'text-default';
export const DEFAULT_TEXT_SIZE: TextSize = 80;

export function textSize(value?: number): TextSize {
  return TEXT_SIZES.find(size => size === value) ?? DEFAULT_TEXT_SIZE;
}

export function nextTextSize(value: number | undefined, intent: TextSizeIntent): TextSize {
  if (intent === 'text-default') return DEFAULT_TEXT_SIZE;
  const index = TEXT_SIZES.indexOf(textSize(value));
  return TEXT_SIZES[Math.max(0, Math.min(TEXT_SIZES.length - 1, index + (intent === 'text-larger' ? 1 : -1)))];
}

/** A root variable also reaches dialogs mounted outside the app root. */
export function useAppliedTextSize(value?: number): TextSize {
  const size = textSize(value);
  useEffect(() => { document.documentElement.style.setProperty('--text-scale', String(size / 100)); }, [size]);
  return size;
}
