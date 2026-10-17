import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampDockHeight, DOCK_FOLD_THRESHOLD, DOCK_LINE, DOCK_MAX, DOCK_MIN, DOCK_RESERVED,
  loadDockHeight, releaseDockHeight, saveDockHeight } from '../../../src/state/dock/height';

const KEY = 'ariadne.dock.height.v1';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('answer dock height', () => {
  it('uses the board limits; no saved height means auto', () => {
    expect([DOCK_MIN, DOCK_MAX, DOCK_LINE, DOCK_FOLD_THRESHOLD, DOCK_RESERVED]).toEqual([180, 2400, 40, 120, 96]);
    expect(loadDockHeight({ getItem: () => null })).toBeNull();
  });

  it.each([DOCK_MIN, 330, 720, DOCK_MAX])('restores a saved %i pixel height', height => {
    const values = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => { values.set(key, value); });
    expect(saveDockHeight(height, { setItem })).toBe(true);
    expect(setItem).toHaveBeenCalledExactlyOnceWith(KEY, JSON.stringify(height));
    const getItem = vi.fn((key: string) => values.get(key) ?? null);
    expect(loadDockHeight({ getItem })).toBe(height);
    expect(getItem).toHaveBeenCalledExactlyOnceWith(KEY);
  });

  it.each(['', 'garbage', 'undefined', 'NaN', 'Infinity', 'null', 'true', '"330"', '[]', '[330]',
    '{}', '{"height":330}', '179', '2401', '330.5', '-1', '1e309'])('ignores corrupt or invalid stored height %s', raw => {
    expect(loadDockHeight({ getItem: () => raw })).toBeNull();
  });

  it.each([DOCK_MIN - 1, DOCK_MAX + 1, 330.5, NaN, Infinity, -Infinity])('does not save invalid height %s', height => {
    const setItem = vi.fn();
    expect(saveDockHeight(height, { setItem })).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('uses its own browser storage key without changing unrelated browser data', () => {
    localStorage.setItem('unrelated', 'owner data');
    expect(saveDockHeight(610)).toBe(true);
    expect(loadDockHeight()).toBe(610);
    expect(localStorage.getItem('unrelated')).toBe('owner data');
    expect(localStorage.length).toBe(2);
  });

  it('tolerates blocked reads, failed writes, and an inaccessible browser storage', () => {
    expect(loadDockHeight({ getItem: () => { throw new Error('blocked'); } })).toBeNull();
    expect(saveDockHeight(610, { setItem: () => { throw new Error('quota'); } })).toBe(false);
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('blocked'); });
    expect(loadDockHeight()).toBeNull();
    expect(saveDockHeight(610)).toBe(false);
  });

  it('tolerates an environment without browser storage', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadDockHeight()).toBeNull();
    expect(saveDockHeight(610)).toBe(false);
  });

  it('clamps a drag between 180 and the window less 96', () => {
    expect(clampDockHeight(100, 800)).toBe(DOCK_MIN);
    expect(clampDockHeight(310.6, 800)).toBe(311);
    expect(clampDockHeight(900, 800)).toBe(704);
    expect(clampDockHeight(900, 200)).toBe(DOCK_MIN);
    expect(clampDockHeight(2500, 3000)).toBe(DOCK_MAX);
    expect(clampDockHeight(NaN, 800)).toBe(DOCK_MIN);
    expect(clampDockHeight(900, NaN)).toBe(900);
  });

  it.each([[60, null], [119, null], [120, 180], [179, 180], [180, 180], [400, 400], [790, 704]] as const)('releasing at %i px gives %s (null folds)', (value, height) => {
    expect(releaseDockHeight(value, 800)).toEqual(height === null ? { fold: true } : { fold: false, height });
  });
});
