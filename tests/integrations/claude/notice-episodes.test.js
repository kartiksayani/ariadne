import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRegister } from '../../../integrations/claude/plugin/hooks/register.js';
import { NOTICES } from '../../../integrations/claude/plugin/hooks/claims.js';
import { ModError, noticeEpisodes } from '../../../integrations/claude/plugin/hooks/contracts.js';
import { binding, descriptor, failure, host, ids } from './fixtures.js';

const heartbeatRetry = 'Ariadne could not check in with the app; it will keep trying, and you can open Ariadne to check that it is running.';
const mismatch = "Ariadne and its Claude plugin don't match, so this was not recorded. Update both to the same version.";
const connectFailure = 'Ariadne could not finish connecting this conversation. Run /ariadne-connect again; if it keeps happening, update Ariadne and its Claude plugin.';
const steps = (count, value, start = 0, interval = 30000) => Array.from({length:count},(_,i) => [start + i * interval,typeof value === 'function' ? value(i) : value]);
const rows = [
  {name:'success only',steps:steps(21,null),notices:0},
  {name:'one transient blip',steps:[[0,'io_error'],...steps(3,null,30000)],notices:0},
  {name:'exact two-minute threshold',steps:[[0,'store_busy'],[119999,'store_busy'],[120000,'store_busy']],notices:1},
  {name:'flapping every call for ten minutes',steps:steps(21,i => i % 2 ? null : 'store_busy'),notices:1},
  {name:'alternating busy, timeout and rejected process',steps:steps(21,i => ['store_busy','timeout','rejection'][i % 3]),notices:1},
  {name:'long outage, sustained recovery, second long outage',steps:[...steps(6,'host_unreachable'),...steps(3,null,180000),...steps(6,'io_error',270000)],notices:2},
  {name:'short successes do not reset a notice',steps:[[0,'incompatible_adapter'],[30000,null],[60000,'permission_denied'],[90000,null],[120000,'store_busy']],immediate:true,notices:1},
  {name:'binding gone',steps:steps(3,'stale_generation'),immediate:true,notices:1},
  {name:'version mismatch',steps:steps(3,'incompatible_adapter'),immediate:true,notices:1},
];

function hooksFor() {
  const hooks = new Map();
  createRegister(descriptor,{waitMs:0,pollMs:0})((name,pattern,handler) => {
    if (typeof pattern === 'function') handler = pattern;
    hooks.set(pattern?.command ?? name,handler);
  });
  return hooks;
}

afterEach(() => vi.useRealTimers());
describe.each(['heartbeat','claim'])('%s notice episode invariant', source => {
  it.each(rows)('$name',async row => {
    vi.useFakeTimers();vi.setSystemTime(0);
    let outcome = null;
    const h = host({handler:argv => {
      if (argv[2] !== (source === 'heartbeat' ? 'announce' : 'claim') || outcome === null) return;
      if (outcome === 'rejection') throw new Error('private session content must never be logged');
      return failure(outcome);
    }});
    const hooks = hooksFor();
    await hooks.get('session.start')(h.$,{},async event => event);
    if (source === 'claim') await hooks.get('ariadne-connect')(h.$,{args:''});
    h.store.delete('connect-log');
    const poll = h.timers().find(timer => timer.ms === (source === 'heartbeat' ? 30000 : 1000)).callback;
    for (const [time,value] of row.steps) {
      vi.setSystemTime(time);outcome = value;await poll();
      if (!row.immediate && time < 120000) expect(h.logs).toEqual([]);
    }
    const text = row.immediate
      ? row.name === 'binding gone'
        ? source === 'claim' ? NOTICES.removed : "This conversation's link to its Ariadne session is out of date or was removed. Run /ariadne-connect to connect it again."
        : mismatch
      : source === 'heartbeat' ? heartbeatRetry : NOTICES.failure;
    expect(h.logs).toEqual(Array(row.notices).fill(text));
    expect(h.logs).not.toContain(connectFailure);
    expect(h.calls.filter(call => ['announce','claim'].includes(call.argv[2])).every(call => call.options.timeoutMs === 8000)).toBe(true);
    const log = h.store.get('connect-log') ?? [];
    expect(log.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(log)).not.toMatch(/private session|original-host|project_id|session_id/);
    if (row.notices) expect(log).toContainEqual(expect.objectContaining({step:source === 'heartbeat' ? 'announce' : 'claim',outcome:'started',code:expect.any(String),at:expect.any(String)}));
    if (row.name.startsWith('long outage')) {
      expect(log.map(record => record.outcome)).toEqual(['started','recovered','started']);
      expect(log.map(record => record.code)).toEqual(['host_unreachable','host_unreachable','io_error']);
    }
    if (row.name.startsWith('flapping') || row.name.startsWith('alternating')) expect(log).toHaveLength(1);
  });
});

it('serializes background diagnostics with owner records, bounds retention and drops untrusted codes',async () => {
  const h = host();
  h.store.set('connect-log',Array.from({length:20},() => ({step:'connect',outcome:'ok'})));
  const notices = noticeEpisodes(() => 0);
  const error = new ModError('private diagnostic');error.code = 'private-session-name';
  await Promise.all([
    notices.fail(h.$,'announce',error,'Update Ariadne.'),
    notices.fail(h.$,'claim',error,'Update Ariadne.'),
  ]);
  const log = h.store.get('connect-log');
  expect(log).toHaveLength(20);
  expect(log.slice(-2)).toEqual(['announce','claim'].map(step => ({step,outcome:'started',code:'protocol_error',at:'1970-01-01T00:00:00.000Z'})));
  h.$.store.get = async () => {throw new Error('storage unavailable');};
  await notices.fail(h.$,'helper',error,'Update Ariadne.');
  expect(h.logs).toEqual(Array(3).fill('Update Ariadne.'));
});

it('a real owner connect failure speaks immediately',async () => {
  const h = host({handler:argv => {if (argv[1] === 'project') throw new Error('private diagnostic');}});
  const hooks = hooksFor();
  await hooks.get('session.start')(h.$,{},async event => event);
  expect((await hooks.get('ariadne-connect')(h.$,{args:''})).text).toBe(`That did not complete. ${connectFailure}`);
  expect(h.logs).toEqual([connectFailure]);
});

it('retries rejected startup qualification, warns after grace, and recovers intake without an owner command',async () => {
  vi.useFakeTimers();vi.setSystemTime(0);
  let rejected = true;
  const h = host({handler:argv => {if (argv[1] === '--version' && rejected) throw new Error('private diagnostic');}});
  h.store.set(`binding:${binding.external_session_id}`,{project_id:ids.project,session_id:ids.session,saved_at:'2026-01-01T00:00:00.000Z'});
  const hooks = hooksFor();
  await hooks.get('session.start')(h.$,{},async event => event);
  const beat = h.timers().find(timer => timer.ms === 30000).callback;
  expect(h.timer()).toBe(null);expect(h.logs).toEqual([]);
  vi.setSystemTime(119999);await beat();expect(h.logs).toEqual([]);
  vi.setSystemTime(120000);await beat();await beat();expect(h.logs).toEqual([heartbeatRetry]);
  rejected = false;await beat();
  expect(h.timer()).not.toBe(null);
  expect(h.calls.filter(call => call.argv[1] === 'binding' && call.argv[2] === 'connect')).toHaveLength(1);
  await h.timer().callback();
  expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(1);
  await beat();await beat();
  expect(h.store.get('connect-log').filter(record => record.step === 'qualification').map(record => record.outcome)).toEqual(['started','recovered']);
});

it('keeps lease refusals quiet even beyond grace',async () => {
  vi.useFakeTimers();vi.setSystemTime(0);
  let unleased = false;
  const h = host({handler:argv => unleased && argv[2] === 'claim' ? failure('not_found',{reason:'lease_invalid'}) : undefined});
  const hooks = hooksFor();
  await hooks.get('session.start')(h.$,{},async event => event);
  await hooks.get('ariadne-connect')(h.$,{args:''});
  unleased = true;await h.timer().callback();
  vi.setSystemTime(600000);await h.timer().callback();
  expect(h.logs).toEqual([]);
});
