import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscoveryController, candidateIdentity } from '../../../src/data/discovery';
import { createDesktopService, ServiceFailure, type DesktopTransport } from '../../../src/data/service';
import type { DesktopDiscoveryCandidate, DesktopDiscoverySnapshot } from '../../../src/generated/core';

export const candidate = (id = 'thread'): DesktopDiscoveryCandidate => ({ adapter_id: 'codex', endpoint: { kind: 'unix_socket', path: '/tmp/codex.sock' },
  external_session_id: id, cwd: '/tmp/project', title: 'Existing conversation', host_version: 'fixture', observed_at: '2026-10-01T00:00:00.000Z',
  freshness: 'fresh', compatibility: 'unknown', availability: 'unknown', loaded: true, binding_id: null, session: null });
const snapshot = (): DesktopDiscoverySnapshot => ({ candidates: [candidate()], error: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 12; ++i) await Promise.resolve(); };
const controllers: DiscoveryController[] = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.useRealTimers(); });
function setup() {
  const discovery = vi.fn<() => Promise<DesktopDiscoverySnapshot>>().mockResolvedValue(snapshot());
  const open = vi.fn<(open: boolean) => Promise<void>>().mockResolvedValue();
  const controller = new DiscoveryController({ discovery, setConnectionUiOpen: open }); controllers.push(controller);
  return { controller, discovery, open };
}
describe('one application discovery lifetime', () => {
  it('combines consumers, polls at five seconds and closes only after the last dismissal', async () => {
    vi.useFakeTimers(); const { controller, discovery, open } = setup();
    const closeProjects = controller.acquire(), closeDialog = controller.acquire(); await flush();
    expect(open.mock.calls).toEqual([[true]]); expect(discovery).toHaveBeenCalledTimes(1);
    closeProjects(); await flush(); expect(open.mock.calls).toEqual([[true]]);
    await vi.advanceTimersByTimeAsync(5000); expect(discovery).toHaveBeenCalledTimes(2);
    closeDialog(); closeDialog(); await flush(); expect(open.mock.calls).toEqual([[true], [false]]);
    await vi.advanceTimersByTimeAsync(10000); expect(discovery).toHaveBeenCalledTimes(2);
  });
  it('serializes delayed activation and StrictMode replay, and disposal closes an outstanding open', async () => {
    const { controller, discovery, open } = setup(); const delayed = deferred<void>(); open.mockReturnValueOnce(delayed.promise);
    const first = controller.acquire(); await flush(); first(); const second = controller.acquire();
    await flush(); expect(open.mock.calls).toEqual([[true]]); expect(discovery).not.toHaveBeenCalled();
    delayed.resolve(); await flush(); expect(open.mock.calls).toEqual([[true], [false], [true]]); expect(discovery).toHaveBeenCalledTimes(1);
    second(); controller.dispose(); await flush(); expect(open.mock.calls.at(-1)).toEqual([false]);
    controller.acquire(); await flush(); expect(open.mock.calls.at(-1)).toEqual([false]);
  });
  it('allows only one read and ignores a response from the closed consumer revision', async () => {
    vi.useFakeTimers(); const { controller, discovery } = setup(); const read = deferred<DesktopDiscoverySnapshot>(); discovery.mockReturnValueOnce(read.promise);
    const close = controller.acquire(); await flush(); await controller.refresh(); await vi.advanceTimersByTimeAsync(15000);
    expect(discovery).toHaveBeenCalledTimes(1); close(); await flush();
    read.resolve(snapshot()); await flush(); expect(controller.getSnapshot().snapshot).toBeNull();
    controller.acquire(); await flush(); expect(discovery).toHaveBeenCalledTimes(2); expect(controller.getSnapshot().snapshot).toEqual(snapshot());
  });
  it('retains the last complete snapshot across transport, invalid and native provider errors', async () => {
    const { controller, discovery } = setup(); controller.acquire(); await flush();
    const complete = controller.getSnapshot().snapshot;
    discovery.mockRejectedValueOnce(new Error('sensitive arbitrary error'));
    await controller.refresh(); expect(controller.getSnapshot().snapshot).toBe(complete); expect(controller.getSnapshot().error).not.toContain('sensitive');
    discovery.mockResolvedValueOnce({ candidates: Array.from({ length: 257 }, (_, i) => candidate(String(i))), error: null });
    await controller.refresh(); expect(controller.getSnapshot().snapshot).toBe(complete);
    discovery.mockResolvedValueOnce({ candidates: [], error: { code: 'host_unreachable', message: 'Unavailable', hint: 'Refresh', retryable: false, field_errors: [] } });
    await controller.refresh(); expect(controller.getSnapshot().snapshot).toBe(complete);
    await controller.refresh(); expect(controller.getSnapshot().error).toBeNull();
  });
  it('does not publish an old read after the dialog was dismissed and reopened', async () => {
    vi.useFakeTimers(); const { controller, discovery } = setup(); const read = deferred<DesktopDiscoverySnapshot>(); discovery.mockReturnValueOnce(read.promise);
    const close = controller.acquire(); await flush(); close(); controller.acquire(); await flush();
    expect(discovery).toHaveBeenCalledTimes(1);
    read.resolve({ candidates: [candidate('obsolete')], error: null }); await flush();
    expect(controller.getSnapshot().snapshot).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(controller.getSnapshot().snapshot).toEqual(snapshot());
  });
  it('shows activation errors and can retry explicitly without creating a read storm', async () => {
    const { controller, discovery, open } = setup(); open.mockRejectedValueOnce(new Error('failed'));
    controller.acquire(); await flush();
    expect(open).toHaveBeenCalledTimes(1); expect(discovery).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error).toBeTruthy();
    await controller.refresh(); await flush();
    expect(open).toHaveBeenCalledTimes(2); expect(discovery).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().snapshot).toEqual(snapshot());
  });
});
describe('desktop transport projection', () => {
  function service(read: () => Promise<DesktopDiscoverySnapshot>, open = vi.fn().mockResolvedValue(undefined)) {
    const transport: DesktopTransport = { invoke: vi.fn(), listen: vi.fn(), discovery: read, setConnectionUiOpen: open };
    return { service: createDesktopService(transport), open };
  }
  it('uses the trusted transport callbacks and preserves all three identity parts', async () => {
    const { service: desktop, open } = service(async () => snapshot());
    expect(await desktop.discovery()).toEqual(snapshot()); await desktop.setConnectionUiOpen(true); await desktop.setConnectionUiOpen(false);
    expect(open.mock.calls).toEqual([[true], [false]]);
    expect(candidateIdentity(candidate())).not.toBe(candidateIdentity({ ...candidate(), adapter_id: 'claude_code_mod' }));
    expect(candidateIdentity(candidate())).not.toBe(candidateIdentity({ ...candidate(), endpoint: { kind: 'unix_socket', path: '/other.sock' } }));
    expect(candidateIdentity(candidate())).not.toBe(candidateIdentity(candidate('other')));
  });
  it('rejects duplicates, excessive candidate count, oversized bytes and malformed metadata', async () => {
    const invalid: DesktopDiscoverySnapshot[] = [
      { candidates: [candidate(), candidate()], error: null },
      { candidates: Array.from({ length: 257 }, (_, i) => candidate(String(i))), error: null },
      { candidates: Array.from({ length: 256 }, (_, i) => ({ ...candidate(String(i)), title: '界'.repeat(1365) })), error: null },
      { candidates: [{ ...candidate(), cwd: '' }], error: null },
      { candidates: [{ ...candidate(), loaded: undefined as unknown as boolean }], error: null },
    ];
    for (const value of invalid) await expect(service(async () => value).service.discovery()).rejects.toEqual(new ServiceFailure('invalid_response'));
  });
});
