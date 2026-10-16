import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRegister } from '../../../integrations/claude/plugin/hooks/register.js';
import { NOTICES } from '../../../integrations/claude/plugin/hooks/claims.js';
import { connectDiagnostic, ModError, noticeEpisodes } from '../../../integrations/claude/plugin/hooks/contracts.js';
import { binding, deferred, descriptor, failure, host, ids } from './fixtures.js';

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
  {name:'short successes do not reset the same meaning',steps:[[0,'incompatible_adapter'],[30000,null],[60000,'incompatible_adapter'],[90000,null],[120000,'incompatible_adapter']],immediate:true,notices:1},
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
    const expectedRecords = row.name === 'success only' ? 0 : row.name === 'one transient blip' ? 2
      : row.name.startsWith('long outage') ? 3 : row.name === 'binding gone' && source === 'claim' ? 2 : 1;
    await vi.waitFor(() => expect(h.store.get('hook-log') ?? []).toHaveLength(expectedRecords));
    const log = h.store.get('hook-log') ?? [];
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

const autoClosed = 'Ariadne: the Ariadne session for this conversation is closed. It will reconnect if you reopen it in the app.';
const autoGone = 'Ariadne: the Ariadne session for this conversation no longer exists. Run /ariadne-connect to connect again.';
const autoConflict = 'This Ariadne session is connected to another conversation.';
// Every changed meaning is visible; repeating that meaning is quiet. Times and
// complete transcripts pin grace, terminal authority and recovery together.
const transitions = [
  ...['stale_generation','binding_mismatch','not_found'].map(code => ({name:`paused then removed (${code})`,source:'claim',events:[
    [0,'invalid_transition','owner_paused',[NOTICES.owner_paused]],
    [1000,code,code === 'not_found' ? 'session_removed' : undefined,[NOTICES.owner_paused,NOTICES.removed]],
    [2000,code,undefined,[NOTICES.owner_paused,NOTICES.removed]],
  ],terminal:true})),
  {name:'retry shown then removed',source:'claim',events:[
    [0,'host_unreachable',undefined,[]],[120000,'store_busy',undefined,[NOTICES.failure]],
    [121000,'stale_generation',undefined,[NOTICES.failure,NOTICES.removed]],
  ],terminal:true},
  ...['owner_paused','session_closed','recovery_required','unrecognized'].map(reason => ({name:`retry shown then held (${reason})`,source:'claim',events:[
    [0,'host_unreachable',undefined,[]],[120000,'host_unreachable',undefined,[NOTICES.failure]],
    [121000,'invalid_transition',reason,[NOTICES.failure,NOTICES[reason] ?? NOTICES.blocked]],
    [122000,'invalid_transition',reason,[NOTICES.failure,NOTICES[reason] ?? NOTICES.blocked]],
  ]})),
  ...['claim','heartbeat'].map(source => ({name:`retry shown then version mismatch (${source})`,source,events:[
    [0,'host_unreachable',undefined,[]],[120000,'host_unreachable',undefined,[source === 'claim' ? NOTICES.failure : heartbeatRetry]],
    [121000,'incompatible_adapter',undefined,[source === 'claim' ? NOTICES.failure : heartbeatRetry,mismatch]],
    [122000,'incompatible_adapter',undefined,[source === 'claim' ? NOTICES.failure : heartbeatRetry,mismatch]],
  ]})),
  ...[['not_found',autoGone],['binding_conflict',autoConflict]].map(([code,text]) => ({name:`auto closed then ${code}`,source:'auto',events:[
    [0,'invalid_transition','session_closed',[autoClosed]],
    [30000,code,undefined,[autoClosed,text]],
    [60000,code,undefined,[autoClosed,text]],
  ],terminal:code === 'not_found'})),
  {name:'transient then paused then transient gets fresh grace',source:'claim',events:[
    [0,'host_unreachable',undefined,[]],[120000,'host_unreachable',undefined,[NOTICES.failure]],
    [121000,'invalid_transition','owner_paused',[NOTICES.failure,NOTICES.owner_paused]],
    [122000,'store_busy',undefined,[NOTICES.failure,NOTICES.owner_paused]],
    [241999,'io_error',undefined,[NOTICES.failure,NOTICES.owner_paused]],
    [242000,'timeout',undefined,[NOTICES.failure,NOTICES.owner_paused,NOTICES.failure]],
  ]},
  {name:'long lease refusal cannot age the first busy failure',source:'claim',events:[
    [0,'not_found','lease_invalid',[]],[600000,'not_found','lease_invalid',[]],
    [601000,'store_busy',undefined,[]],[720999,'store_busy',undefined,[]],
    [721000,'store_busy',undefined,[NOTICES.failure]],
  ]},
];

it.each(transitions)('$name',async row => {
  vi.useFakeTimers();vi.setSystemTime(0);
  let current = null;
  const h = host({handler:argv => {
    const trigger = row.source === 'heartbeat' ? argv[2] === 'announce'
      : row.source === 'auto' ? argv[1] === 'binding' && !argv.includes('--replay-only') : argv[2] === 'claim';
    if (trigger && current) return failure(current[1],current[2] ? {reason:current[2]} : undefined);
  }});
  const hooks = hooksFor();
  await hooks.get('session.start')(h.$,{},async event => event);
  if (row.source === 'claim') await hooks.get('ariadne-connect')(h.$,{args:''});
  if (row.source === 'auto') {
    h.store.set('binding:resumed-conversation',{project_id:ids.project,session_id:ids.session,saved_at:'2026-01-01T00:00:00.000Z'});
    h.switchSession('resumed-conversation');
  }
  const poll = h.timers().find(timer => timer.ms === (row.source === 'claim' ? 1000 : 30000)).callback;
  for (const event of row.events) {
    current = event;vi.setSystemTime(event[0]);await poll();
    expect(h.logs).toEqual(event[3]);
  }
  if (row.terminal) {
    const calls = h.calls.length;
    await h.timer().callback();
    expect(h.calls).toHaveLength(calls);
    await vi.waitFor(() => expect(h.store.get('hook-log')).toContainEqual(expect.objectContaining({outcome:'ended',code:row.events.at(-1)[1]})));
  }
  if (row.source === 'auto') {
    await vi.waitFor(() => expect(h.store.get('hook-log')).toContainEqual(expect.objectContaining({code:'invalid_transition'})));
    await vi.waitFor(() => expect(h.store.get('hook-log')).toContainEqual(expect.objectContaining({code:row.events.at(-1)[1]})));
  }
});

it.each(['announce','turn.start','turn.complete'])('successful %s closes helper failure after three good calls',async trigger => {
  let armed = false;
  const h = host({handler:argv => armed && argv[2] === 'connection-status' ? failure('permission_denied') : undefined});
  const hooks = hooksFor();
  await hooks.get('session.start')(h.$,{},async event => event);
  await hooks.get('ariadne-connect')(h.$,{args:''});armed = true;
  const fail = () => hooks.get('ariadne-status')(h.$);
  const good = () => trigger === 'announce' ? h.timers().find(timer => timer.ms === 30000).callback()
    : hooks.get(trigger)(h.$,{},async event => event);
  await fail();await good();await good();await fail();
  expect(h.logs).toHaveLength(1);
  await good();await good();await good();await fail();
  expect(h.logs).toEqual(Array(2).fill("Ariadne isn't allowed to do that. Open the Ariadne app to check what is allowed for this session."));
});

it.each(['get','set'])('hung diagnostic store.%s never holds the claim poll or terminal callback',async method => {
  let code = 'store_busy';
  const h = host({handler:argv => argv[2] === 'claim' ? failure(code) : undefined});
  const hooks = hooksFor();
  await hooks.get('session.start')(h.$,{},async event => event);
  await hooks.get('ariadne-connect')(h.$,{args:''});
  const held = deferred(), original = h.$.store[method];
  h.$.store[method] = (key,...args) => key.endsWith('-log') ? held.promise : original(key,...args);
  try {
    await h.timer().callback();
    code = 'stale_generation';await h.timer().callback();
    expect(h.logs).toEqual([NOTICES.removed]);
    expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(2);
  } finally { held.resolve(); }
});

it('bounds queued background records while storage hangs and leaves owner writes independent',async () => {
  const h = host(), held = deferred();
  const original = h.$.store.get;
  let first = true;
  h.$.store.get = async key => {
    if (key === 'hook-log' && first) {first = false;await held.promise;}
    return original(key);
  };
  const notices = noticeEpisodes(() => 0), error = new ModError('Fixture diagnostic');error.code = 'unsupported';
  try {
    for (let i = 0; i < 50; i += 1) notices.fail(h.$,`slot-${i}`,error,'Update Ariadne.');
    await connectDiagnostic(h.$,{operation_id:'retained-operation',step:'connect',outcome:'ok'});
    expect(h.store.get('connect-log')).toEqual([{operation_id:'retained-operation',step:'connect',outcome:'ok'}]);
  } finally { held.resolve(); }
  await vi.waitFor(() => expect(h.store.get('hook-log')?.map(record => record.step)).toEqual(Array.from({length:20},(_,i) => `slot-${i + 30}`)));
});

it('distinguishes future non-transient codes without recording untrusted code text',async () => {
  const h = host(), notices = noticeEpisodes();
  for (const code of ['future_one','future_one','future_two','future_two']) {
    const error = new ModError('Private detail');error.code = code;
    notices.fail(h.$,'announce',error,'Update Ariadne.');
  }
  expect(h.logs).toEqual(['Update Ariadne.','Update Ariadne.']);
  await vi.waitFor(() => expect(h.store.get('hook-log')).toHaveLength(2));
  expect(h.store.get('hook-log').map(record => record.code)).toEqual(['protocol_error','protocol_error']);
});

it('separates bounded background diagnostics from owner history and drops untrusted codes',async () => {
  const h = host();
  const ownerRecords = Array.from({length:20},(_,i) => ({operation_id:`operation-${i}`,step:'connect',outcome:'ok'}));
  h.store.set('connect-log',ownerRecords);
  h.store.set('hook-log',Array.from({length:20},() => ({step:'announce',outcome:'recovered'})));
  const notices = noticeEpisodes(() => 0);
  const error = new ModError('private diagnostic');error.code = 'private-session-name';
  await Promise.all([
    notices.fail(h.$,'announce',error,'Update Ariadne.'),
    notices.fail(h.$,'claim',error,'Update Ariadne.'),
  ]);
  await vi.waitFor(() => expect(h.store.get('hook-log').at(-1)?.step).toBe('claim'));
  const log = h.store.get('hook-log');
  expect(log).toHaveLength(20);
  expect(h.store.get('connect-log')).toEqual(ownerRecords);
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
  await vi.waitFor(() => expect((h.store.get('hook-log') ?? []).filter(record => record.step === 'qualification').map(record => record.outcome)).toEqual(['started','recovered']));
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
