import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampDockHeight, DOCK_DEFAULT, DOCK_FOLD_THRESHOLD, DOCK_LINE, DOCK_MAX, DOCK_MIN,
  loadDockHeight, saveDockHeight } from '../../../src/state/dock/height';

const KEY = 'ariadne.redesign.answerDock.height.v1';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('answer dock height', () => {
  it('uses the settled open, folded, and drag limits', () => {
    expect([DOCK_DEFAULT, DOCK_MIN, DOCK_MAX, DOCK_LINE, DOCK_FOLD_THRESHOLD]).toEqual([330, 180, 2400, 40, 120]);
    expect(loadDockHeight({ getItem: () => null })).toBe(DOCK_DEFAULT);
  });

  it.each([DOCK_MIN, DOCK_DEFAULT, 720, DOCK_MAX])('restores a saved %i pixel height across consumers', height => {
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
    expect(loadDockHeight({ getItem: () => raw })).toBe(DOCK_DEFAULT);
  });

  it.each([DOCK_MIN - 1, DOCK_MAX + 1, 330.5, NaN, Infinity, -Infinity])('does not save invalid height %s', height => {
    const setItem = vi.fn();
    expect(saveDockHeight(height, { setItem })).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('uses the namespaced browser storage by default without changing unrelated browser data', () => {
    localStorage.setItem('unrelated', 'owner data');
    expect(saveDockHeight(610)).toBe(true);
    expect(loadDockHeight()).toBe(610);
    expect(localStorage.getItem('unrelated')).toBe('owner data');
    expect(localStorage.length).toBe(2);
  });

  it('tolerates blocked reads, failed writes, and an inaccessible browser storage getter', () => {
    expect(loadDockHeight({ getItem: () => { throw new Error('blocked'); } })).toBe(DOCK_DEFAULT);
    expect(saveDockHeight(610, { setItem: () => { throw new Error('quota'); } })).toBe(false);
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('blocked'); });
    expect(loadDockHeight()).toBe(DOCK_DEFAULT);
    expect(saveDockHeight(610)).toBe(false);
  });

  it('tolerates an environment without browser storage', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadDockHeight()).toBe(DOCK_DEFAULT);
    expect(saveDockHeight(610)).toBe(false);
  });

  it('rounds drag coordinates and clamps to the available height without exceeding saved limits', () => {
    expect(clampDockHeight(100)).toBe(DOCK_MIN);
    expect(clampDockHeight(310.6)).toBe(311);
    expect(clampDockHeight(2500)).toBe(DOCK_MAX);
    expect(clampDockHeight(900, 600.8)).toBe(600);
    expect(clampDockHeight(900, 100)).toBe(DOCK_MIN);
    expect(clampDockHeight(2500, 3000)).toBe(DOCK_MAX);
    expect(clampDockHeight(NaN)).toBe(DOCK_DEFAULT);
    expect(clampDockHeight(Infinity, 250)).toBe(250);
    expect(clampDockHeight(900, NaN)).toBe(900);
  });
});
