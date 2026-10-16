import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRegister } from '../../../integrations/claude/plugin/hooks/register.js';
import { claimLoop, NOTICES } from '../../../integrations/claude/plugin/hooks/claims.js';
import { BACKGROUND_RETRY, backgroundDiagnostic, backgroundOutcome, connectDiagnostic, conversationHealth, failureCode, ModError, plainFailure } from '../../../integrations/claude/plugin/hooks/contracts.js';
import { qualify, setup } from '../../../integrations/claude/plugin/hooks/setup.js';
import { announcements } from '../../../integrations/claude/plugin/hooks/discovery.js';
import { binding, deferred, descriptor, failure, host, ids, prepared, status, success } from './fixtures.js';

const heartbeatRetry = BACKGROUND_RETRY;
const mismatch = plainFailure('incompatible_adapter');
const permissionDenied = plainFailure('permission_denied');
const recovery = plainFailure('invalid_transition',{reason:'recovery_required'});
const connectFailure = 'Ariadne could not finish connecting this conversation. Run /ariadne-connect again; if it keeps happening, update Ariadne and its Claude plugin.';
const intervals = {announce:30000,helper:30000,auto:30000,qualification:30000,claim:1000,reports:1000};
const producers = Object.keys(intervals);
const permanentSpawns = ['ENOENT','EACCES','EPERM','ENOEXEC','ENOTDIR','EISDIR','ELOOP','ENAMETOOLONG'];
const visible = h => h.logs.filter(line => !line.startsWith('Ariadne: turn.start carried'));
function noticeError(code, details) {
  if (code === 'process_rejected' || code === 'rejection') return new Error('Private fixture detail');
  if (code.startsWith('spawn:')) return Object.assign(new Error('Private fixture detail'),{code:code.slice(6)});
  return Object.assign(new ModError('Private fixture detail'),{code,...details ? {details} : {}});
}
function hooksFor() {
  const hooks = new Map();
  createRegister(descriptor,{waitMs:0,pollMs:0})((name,pattern,handler) => {
    if (typeof pattern === 'function') handler = pattern;
    hooks.set(pattern?.command ?? name,handler);
  });
  return hooks;
}
// Milestones describe changes, while intermediate calls keep each producer at
// its real cadence. A long silent gap is used only by explicit idle scenarios.
async function until(end, cadence, call) {
  for (let at = Date.now() + cadence; at < end; at += cadence) {vi.setSystemTime(at);await call();}
  vi.setSystemTime(end);
}
afterEach(() => {vi.useRealTimers();vi.restoreAllMocks();});

const producerRows = [
  {name:'success only',events:[[0,null],[600000,null]],lines:[]},
  {name:'one transient blip',events:[[0,'io_error'],[30000,null],[90000,null]],lines:[]},
  {name:'exact two-minute threshold',events:[[0,'store_busy'],[119999,'store_busy'],[120000,'store_busy']],lines:[BACKGROUND_RETRY]},
  {name:'flapping every call for ten minutes',events:Array.from({length:21},(_,i) => [i * 30000,i % 2 ? null : 'store_busy']),lines:[BACKGROUND_RETRY]},
  {name:'alternating busy, timeout and rejected process',events:Array.from({length:21},(_,i) => [i * 30000,['store_busy','timeout','rejection'][i % 3]]),lines:[BACKGROUND_RETRY]},
  {name:'long outage, sustained recovery, second long outage',events:[[0,'host_unreachable'],[120000,'host_unreachable'],[150000,null],[240000,null],[270000,'io_error'],[390000,'io_error']],lines:[BACKGROUND_RETRY,BACKGROUND_RETRY]},
  {name:'installation clears on first successful call',events:[[0,'incompatible_adapter'],[30000,null],[60000,'incompatible_adapter'],[90000,null],[120000,'incompatible_adapter']],lines:[mismatch,mismatch,mismatch]},
  {name:'binding gone',events:[[0,'stale_generation'],[30000,'stale_generation']],removed:true},
  ...permanentSpawns.map(code => ({name:`broken helper ${code}`,events:[[0,`spawn:${code}`],[600000,`spawn:${code}`]],lines:[mismatch]})),
  {name:'temporary spawn exhaustion',events:[[0,'spawn:EAGAIN'],[600000,'spawn:EAGAIN']],lines:[BACKGROUND_RETRY]},
];
describe.each(['heartbeat','claim'])('%s conversation health',source => {
  it.each(producerRows)('$name',async row => {
    vi.useFakeTimers();vi.setSystemTime(0);
    let outcome = null;
    const h = host({handler:argv => {
      if (argv[2] !== (source === 'heartbeat' ? 'announce' : 'claim') || outcome === null) return;
      if (outcome === 'rejection') throw noticeError(outcome);
      if (outcome.startsWith('spawn:')) throw noticeError(outcome);
      return failure(outcome);
    }});
    const hooks = hooksFor();await hooks.get('session.start')(h.$,{},async event => event);
    if (source === 'claim') await hooks.get('ariadne-connect')(h.$,{args:''});
    const cadence = source === 'heartbeat' ? 30000 : 1000;
    const poll = h.timers().find(timer => timer.ms === cadence).callback;
    const events = row.name.startsWith('flapping') ? Array.from({length:600000 / cadence + 1},(_,i) => [i * cadence,i % 2 ? null : 'store_busy']) : row.events;
    for (const [at,value] of events) {
      await until(at,cadence,poll);outcome = value;await poll();
    }
    const lines = row.removed ? [source === 'claim' ? NOTICES.removed : plainFailure('stale_generation')] : row.lines;
    expect(h.logs).toEqual(lines);
    expect(h.logs).not.toContain(connectFailure);
    expect(h.calls.filter(call => ['announce','claim'].includes(call.argv[2])).every(call => call.options.timeoutMs === 8000)).toBe(true);
    await vi.waitFor(() => expect(h.store.get('hook-log') ?? []).toEqual(expect.any(Array)));
    const log = h.store.get('hook-log') ?? [];
    expect(log.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(log)).not.toMatch(/Private fixture|original-host|project_id|session_id/);
  });
});

const transientCodes = ['store_busy','timeout','io_error','process_rejected','host_unreachable','spawn:EAGAIN','spawn:EMFILE','spawn:EPIPE'];
it.each(transientCodes)('genuine transient %s keeps its full grace in every producer',code => {
  vi.useFakeTimers();
  for (const producer of producers) {
    vi.setSystemTime(0);const h = host(), health = conversationHealth();
    for (let at = 0; at <= 600000; at += intervals[producer]) {
      vi.setSystemTime(at);health.record(h.$,producer,backgroundOutcome(noticeError(code),connectFailure));
      expect(h.logs).toEqual(at < 120000 ? [] : [BACKGROUND_RETRY]);
    }
  }
});
it.each(permanentSpawns)('broken helper %s replaces a shown retry immediately across all producers',code => {
  vi.useFakeTimers();vi.setSystemTime(0);const h = host(), health = conversationHealth();
  for (let at = 0; at <= 120000; at += 30000) {
    vi.setSystemTime(at);health.record(h.$,'announce',backgroundOutcome(noticeError('host_unreachable')));
  }
  expect(h.logs).toEqual([BACKGROUND_RETRY]);
  for (const producer of producers) health.record(h.$,producer,backgroundOutcome(noticeError(`spawn:${code}`),connectFailure));
  expect(h.logs).toEqual([BACKGROUND_RETRY,mismatch]);
});
it.each(['descriptor','version','truncated version'])('local qualification %s failure bypasses a shown retry immediately',async cause => {
  vi.useFakeTimers();vi.setSystemTime(0);
  const h = host({handler:argv => argv[1] === '--version' ? {exitCode:0,stdout:cause === 'version' ? 'ariadne 0.0.0\n' : `ariadne ${descriptor.appVersion}\n`,isStdoutTruncated:cause === 'truncated version'} : undefined});
  const health = conversationHealth();
  for (let at = 0; at <= 120000; at += 30000) {vi.setSystemTime(at);health.record(h.$,'announce',backgroundOutcome(noticeError('store_busy')));}
  const caught = await qualify(h.$,cause === 'descriptor' ? null : descriptor).then(() => null,error => error);
  expect(caught).toBeInstanceOf(ModError);expect(failureCode(caught)).toBe('incompatible_adapter');
  health.record(h.$,'qualification',backgroundOutcome(caught,caught.plain));
  expect(h.logs).toEqual([BACKGROUND_RETRY,mismatch]);
});

it.each(producers)('%s clears held/install on the first OK and transient on the third OK',producer => {
  vi.useFakeTimers();vi.setSystemTime(0);const h = host(), health = conversationHealth();
  for (const code of ['permission_denied','incompatible_adapter']) {
    health.record(h.$,producer,backgroundOutcome(noticeError(code)));
    health.record(h.$,producer,{kind:'ok'});expect(health.current()).toEqual({kind:'ok'});
  }
  health.record(h.$,producer,backgroundOutcome(noticeError('store_busy')));
  for (let good = 0; good < 2; good += 1) {health.record(h.$,producer,{kind:'ok'});expect(health.current().kind).toBe('transient');}
  health.record(h.$,producer,{kind:'ok'});expect(health.current()).toEqual({kind:'ok'});
});
it.each(['reset','clear'])('retry then %s then urgent new notice has no stale suppression',mode => {
  vi.useFakeTimers();vi.setSystemTime(0);const h = host(), health = conversationHealth();
  for (let at = 0; at <= 120000; at += 30000) {vi.setSystemTime(at);health.record(h.$,'announce',backgroundOutcome(noticeError('store_busy')));}
  if (mode === 'reset') health.reset();else health.delete(h.$,'announce');
  vi.setSystemTime(120001);health.record(h.$,'claim',backgroundOutcome(noticeError('invalid_transition',{reason:'recovery_required'})));
  expect(h.logs).toEqual([BACKGROUND_RETRY,recovery]);
});
it('recovery_required/store_busy alternation keeps the urgent advice and never alternates it with retry',() => {
  vi.useFakeTimers();vi.setSystemTime(0);const h = host(), health = conversationHealth();
  health.record(h.$,'claim',backgroundOutcome(noticeError('invalid_transition',{reason:'recovery_required'})));
  // A retry line never replaces held advice while its producer neither recovers nor expires.
  for (let at = 1000; at <= 600000; at += 1000) {
    vi.setSystemTime(at);health.record(h.$,'claim',backgroundOutcome(noticeError(at % 2000 ? 'store_busy' : 'invalid_transition',{reason:'recovery_required'})));
    expect(h.logs).toEqual([recovery]);
  }
  // Three good calls recover the claim producer; another producer's outage may then speak.
  for (let at = 600001; at <= 600003; at += 1) {vi.setSystemTime(at);health.record(h.$,'claim',{kind:'ok'});}
  expect(health.current()).toEqual({kind:'ok'});
  for (let at = 700000; at <= 820000; at += 30000) {vi.setSystemTime(at);health.record(h.$,'announce',backgroundOutcome(noticeError('store_busy')));}
  expect(h.logs).toEqual([recovery,BACKGROUND_RETRY]);
});
it.each(['announce','helper','auto','claim'])('%s joins and changes a continuous shown outage without duplicate retry advice',producer => {
  vi.useFakeTimers();vi.setSystemTime(0);const h = host(), health = conversationHealth();
  for (let at = 0; at <= 600000; at += intervals[producer]) {
    vi.setSystemTime(at);health.record(h.$,producer,backgroundOutcome(noticeError(at < 121000 ? 'host_unreachable' : 'store_busy')));
    if (at % 30000 === 0) health.record(h.$,'qualification',backgroundOutcome(noticeError('io_error')));
  }
  expect(h.logs).toEqual([BACKGROUND_RETRY]);
});

it('one failed report then idle then outage 2.5 hours later gets a fresh full grace',async () => {
  vi.useFakeTimers();vi.setSystemTime(0);let refuse = true;
  const value = await prepared(), health = conversationHealth();
  const h = host({claim:value,handler:argv => argv[2] === 'report' && refuse ? failure('io_error') : undefined});
  const loop = claimLoop(descriptor.helperPath,binding,{health});
  await loop.poll(h.$);
  await vi.waitFor(() => expect(h.calls.filter(call => call.argv[2] === 'report')).toHaveLength(1));
  expect(loop.status().pending_reports).toBe(1);
  refuse = false;
  vi.setSystemTime(1000);await loop.drain(h.$);
  expect(h.events.map(event => event.kind)).toEqual(['accepted']);
  expect(loop.status().pending_reports).toBe(0);expect(health.current().kind).toBe('transient');
  vi.setSystemTime(9000000);health.record(h.$,'announce',backgroundOutcome(noticeError('host_unreachable')));
  expect(visible(h)).toEqual([]);
  for (let at = 9030000; at <= 9090000; at += 30000) {vi.setSystemTime(at);health.record(h.$,'announce',backgroundOutcome(noticeError('store_busy')));expect(visible(h)).toEqual([]);}
  vi.setSystemTime(9120000);health.record(h.$,'announce',backgroundOutcome(noticeError('io_error')));
  expect(visible(h)).toEqual([BACKGROUND_RETRY]);
});
it('empty report flushes are OK evidence and rearm a held refusal on the first success',async () => {
  vi.useFakeTimers();vi.setSystemTime(0);let refuse = true;
  const value = await prepared(), submission = deferred(), health = conversationHealth();
  const h = host({claim:value,submit:() => submission.promise,handler:argv => argv[2] === 'report' && refuse ? failure('permission_denied') : undefined});
  const loop = claimLoop(descriptor.helperPath,binding,{health});
  await loop.poll(h.$);await loop.start(h.$,{text:value.formatted_payload,turnId:'report-turn'});
  expect(visible(h)).toEqual([permissionDenied]);
  refuse = false;await loop.drain(h.$);expect(health.current()).toEqual({kind:'ok'});
  await loop.drain(h.$);expect(health.current()).toEqual({kind:'ok'});
  refuse = true;await loop.complete(h.$,{turnId:'report-turn',answer:'Answer',reason:'answer',isAborted:false});
  expect(visible(h)).toEqual([permissionDenied,permissionDenied]);
});
it.each([0,1,3])('a partial report flush with %i saved records cannot clear an unsaved held failure',async saves => {
  vi.useFakeTimers();vi.setSystemTime(0);
  const value = await prepared(), submission = deferred();let remaining = 0;
  const h = host({claim:value,submit:() => submission.promise,handler:argv => argv[2] === 'report' && remaining-- <= 0 ? failure('permission_denied') : undefined});
  const health = conversationHealth(), loop = claimLoop(descriptor.helperPath,binding,{health});
  await loop.poll(h.$);await loop.start(h.$,{text:value.formatted_payload,turnId:'report-turn'});
  for (const answer of ['First answer','Second answer']) await loop.complete(h.$,{turnId:'report-turn',answer,reason:'answer',isAborted:false});
  expect(loop.status().pending_reports).toBe(4);remaining = saves;await loop.drain(h.$);
  expect(h.events).toHaveLength(saves);expect(loop.status().pending_reports).toBe(4 - saves);
  expect(health.current().kind).toBe('held');expect(visible(h)).toEqual([permissionDenied]);
});

it('report-save long failure, real and empty flush recovery, then second long failure',async () => {
  vi.useFakeTimers();vi.setSystemTime(0);let refusing = true;
  const value = await prepared(), submission = deferred(), health = conversationHealth();
  const h = host({claim:value,submit:() => submission.promise,handler:argv => {
    if (argv[2] !== 'report' || !refusing) return;
    const code = ['store_busy','timeout','rejection','io_error'][Math.floor(Date.now() / 1000) % 4];
    if (code === 'rejection') throw noticeError(code);
    return failure(code);
  }});
  const loop = claimLoop(descriptor.helperPath,binding,{health});
  await loop.poll(h.$);await loop.start(h.$,{text:value.formatted_payload,turnId:'report-outage'});
  for (let at = 1000; at <= 120000; at += 1000) {vi.setSystemTime(at);await loop.drain(h.$);}
  expect(visible(h)).toEqual([BACKGROUND_RETRY]);
  refusing = false;
  for (let at = 121000; at <= 123000; at += 1000) {vi.setSystemTime(at);await loop.drain(h.$);}
  expect(health.current()).toEqual({kind:'ok'});expect(loop.status().pending_reports).toBe(0);
  refusing = true;vi.setSystemTime(130000);
  await loop.complete(h.$,{turnId:'report-outage',answer:'Answer',reason:'answer',isAborted:false});
  for (let at = 131000; at < 250000; at += 1000) {vi.setSystemTime(at);await loop.drain(h.$);expect(visible(h)).toEqual([BACKGROUND_RETRY]);}
  vi.setSystemTime(250000);await loop.drain(h.$);expect(visible(h)).toEqual([BACKGROUND_RETRY,BACKGROUND_RETRY]);
});
it.each([
  {name:'held report save gives the actual recovery advice',code:'invalid_transition',details:{reason:'recovery_required'},text:recovery},
  {name:'changed installation failure prints immediately',code:'incompatible_adapter',text:mismatch},
  ...['ENOENT','EACCES'].map(code => ({name:`broken helper ${code} speaks immediately`,code:`spawn:${code}`,text:mismatch})),
])('report-save current advice: $name',async row => {
  vi.useFakeTimers();vi.setSystemTime(0);let changed = false;
  const value = await prepared(), submission = deferred();
  const h = host({claim:value,submit:() => submission.promise,handler:argv => {
    if (argv[2] !== 'report') return;
    if (!changed) return failure('permission_denied');
    if (row.code.startsWith('spawn:')) throw noticeError(row.code);
    return failure(row.code,row.details);
  }});
  const loop = claimLoop(descriptor.helperPath,binding,{health:conversationHealth()});
  await loop.poll(h.$);await loop.start(h.$,{text:value.formatted_payload,turnId:'report-advice'});
  expect(visible(h)).toEqual([permissionDenied]);
  changed = true;vi.setSystemTime(1000);await loop.drain(h.$);
  expect(visible(h)).toEqual([permissionDenied,row.text]);
  vi.setSystemTime(2000);await loop.drain(h.$);expect(visible(h)).toEqual([permissionDenied,row.text]);
});

it('background reconnect keeps owner receipts and records only first and last attempt outcomes',async () => {
  vi.useFakeTimers();vi.setSystemTime(0);let down = false;
  let resumed = false;
  const h = host({handler:argv => {
    if (down && argv[1] !== '--version' && argv[2] !== 'report') return failure('host_unreachable');
    if (resumed && argv[2] === 'connection-status') return success({...status,external_session_id:'resumed-conversation'});
  }});
  const hooks = hooksFor();
  await hooks.get('session.start')(h.$,{},async event => event);
  await hooks.get('ariadne-connect')(h.$,{args:''});
  // Rotate conversation while reachable, but leave its connect waiting for a receipt.
  h.switchSession('resumed-conversation');resumed = true;down = true;
  const receipts = h.store.get('connect-log');
  const beat = h.timers().find(timer => timer.ms === 30000).callback;
  for (let time = 0; time <= 600000; time += 30000) {vi.setSystemTime(time);await beat();}
  expect(h.calls.filter(call => call.argv.includes('--replay-only')).length).toBeGreaterThan(15);
  expect(h.store.get('connect-log')).toEqual(receipts);
  expect(h.logs).toEqual([heartbeatRetry]);
  await vi.waitFor(() => expect((h.store.get('hook-log') ?? []).filter(record => record.step === 'reconnect')).toHaveLength(1));
  down = false;await beat();
  await vi.waitFor(() => expect((h.store.get('hook-log') ?? []).filter(record => record.step === 'reconnect').map(record => [record.outcome,record.code])).toEqual([['started','host_unreachable'],['recovered','ok']]));
  expect(h.store.get('connect-log')).toEqual(receipts);
});

it.each(['get','set'])('hung background reconnect diagnostics (%s) never block retries or owner receipts',async method => {
  let down = false;
  const h = host({handler:argv => down && argv[1] === 'binding' ? failure('host_unreachable') : undefined});
  const owner = setup(descriptor.helperPath);await owner.connect(h.$);
  const receipts = h.store.get('connect-log'), held = deferred(), original = h.$.store[method];
  h.$.store[method] = (key,...args) => key === 'hook-log' ? held.promise : original(key,...args);
  try {
    down = true;
    for (let i = 0; i < 3; i += 1) await expect(owner.connect(h.$,ids.session,{background:true})).rejects.toMatchObject({code:'host_unreachable'});
    expect(h.store.get('connect-log')).toEqual(receipts);
    await expect(owner.connect(h.$,ids.session)).rejects.toMatchObject({code:'host_unreachable'});
    expect(h.store.get('connect-log')).toHaveLength(receipts.length + 1);
    down = false;await owner.connect(h.$,ids.session,{background:true});
  } finally { held.resolve(); }
});

it.each(['disconnect','session end'])('stopping an automatic reconnect with %s records its final outcome',async stop => {
  let down = false;
  const h = host({handler:argv => down && argv[1] === 'binding' ? failure('host_unreachable') : undefined});
  const hooks = hooksFor();await hooks.get('session.start')(h.$,{},async event => event);
  h.store.set('binding:resumed-conversation',{project_id:ids.project,session_id:ids.session,saved_at:'2026-01-01T00:00:00.000Z'});
  h.switchSession('resumed-conversation');down = true;
  const beat = h.timers().find(timer => timer.ms === 30000).callback;
  await beat();
  if (stop === 'disconnect') expect((await hooks.get('ariadne-disconnect')(h.$)).text).toBe('This conversation is not connected to Ariadne.');
  else await hooks.get('session.end')(h.$,{reason:'exit'},async event => event);
  const calls = h.calls.length;await beat();
  expect(h.calls.filter(call => call.argv[1] === 'binding')).toHaveLength(2);
  if (stop === 'session end') expect(h.calls).toHaveLength(calls);
  await vi.waitFor(() => expect((h.store.get('hook-log') ?? []).filter(record => record.step === 'reconnect').map(record => [record.outcome,record.code])).toEqual([['started','host_unreachable'],['ended','host_unreachable']]));
});

it('a late background reply cannot reopen canceled reconnect diagnostics',async () => {
  const held = deferred();let holding = false;
  const h = host({handler:argv => argv[1] === 'binding' ? holding ? held.promise : failure('host_unreachable') : undefined});
  const owner = setup(descriptor.helperPath);
  await expect(owner.connect(h.$,ids.session,{background:true})).rejects.toMatchObject({code:'host_unreachable'});
  holding = true;const attempt = owner.connect(h.$,ids.session,{background:true});
  await vi.waitFor(() => expect(h.calls.filter(call => call.argv[1] === 'binding')).toHaveLength(2));
  owner.endBackground(h.$);held.resolve(failure('store_busy'));
  await expect(attempt).rejects.toMatchObject({code:'store_busy'});
  await vi.waitFor(() => expect(h.store.get('hook-log')?.map(record => [record.outcome,record.code])).toEqual([['started','host_unreachable'],['ended','host_unreachable']]));
});


const publicationFailures = ['spawn:ENOENT','spawn:EACCES','incompatible_adapter','store_busy','timeout','io_error','process_rejected','host_unreachable','spawn:EAGAIN','spawn:EMFILE'];
it.each(['bound announce','status'].flatMap(stage => publicationFailures.map(code => ({stage,code}))))('$stage preserves $code through the saved-binding wrapper',async ({stage,code}) => {
  vi.useFakeTimers();vi.setSystemTime(0);
  const permanent = ['spawn:ENOENT','spawn:EACCES','incompatible_adapter'].includes(code);
  const h = host({handler:(argv,options) => {
    const bound = argv[2] === 'announce' && JSON.parse(options.stdin).binding_scope !== null;
    if (!(stage === 'bound announce' ? bound : argv[2] === 'connection-status')) return;
    if (code.startsWith('spawn:') || code === 'process_rejected') throw noticeError(code);
    return failure(code);
  }});
  const discovery = announcements(descriptor), health = conversationHealth();
  const owner = setup(descriptor.helperPath,(h,binding) => discovery.announce(h,{binding_id:binding.binding_id,generation:binding.generation}),{waitMs:0,pollMs:0});
  for (let at = 0; at <= 150000; at += 30000) {
    vi.setSystemTime(at);
    const error = await owner.connect(h.$,ids.session,{background:true}).then(() => null,error => error);
    expect(error).toBeInstanceOf(Error);
    expect(failureCode(error)).toBe(permanent ? 'incompatible_adapter' : code.startsWith('spawn:') ? 'process_rejected' : code);
    health.record(h.$,'auto',backgroundOutcome(error,error.plain));
    expect(h.logs).toEqual(permanent ? [mismatch] : at < 120000 ? [] : [BACKGROUND_RETRY]);
  }
});
it.each(['spawn:ENOENT','spawn:EACCES','incompatible_adapter','host_unreachable'])('owner connect answers %s directly without a UI log or changing background health',async code => {
  vi.useFakeTimers();vi.setSystemTime(0);let outcome = null;
  const h = host({handler:argv => {
    if (argv[1] === '--version' || outcome === null) return;
    if (outcome.startsWith('spawn:')) throw noticeError(outcome);
    return failure(outcome);
  }});
  const hooks = hooksFor();await hooks.get('session.start')(h.$,{},async event => event);
  const beat = h.timers().find(timer => timer.ms === 30000).callback;
  outcome = 'host_unreachable';
  for (let at = 0; at <= 120000; at += 30000) {vi.setSystemTime(at);await beat();}
  expect(h.logs).toEqual([BACKGROUND_RETRY]);outcome = code;
  for (let i = 0; i < 3; i += 1) {
    const response = await hooks.get('ariadne-connect')(h.$,{args:ids.session});
    expect(response.text).toContain('That did not complete.');
    expect(response.text).not.toContain(BACKGROUND_RETRY);
    expect(h.logs).toEqual([BACKGROUND_RETRY]);
  }
});
it('a real owner connect failure answers immediately without a duplicate UI notice',async () => {
  const h = host({handler:argv => {if (argv[1] === 'project') throw new Error('Private diagnostic');}});
  const hooks = hooksFor();await hooks.get('session.start')(h.$,{},async event => event);
  expect((await hooks.get('ariadne-connect')(h.$,{args:''})).text).toBe(`That did not complete. ${connectFailure}`);
  expect(h.logs).toEqual([]);
});

it.each(['owner_paused','session_closed','recovery_required','unrecognized'])('retry shown then held (%s) changes real claim advice immediately',async reason => {
  vi.useFakeTimers();vi.setSystemTime(0);let code = 'host_unreachable';
  const h = host({handler:argv => argv[2] === 'claim' ? failure(code,code === 'invalid_transition' ? {reason} : undefined) : undefined});
  const hooks = hooksFor();await hooks.get('session.start')(h.$,{},async event => event);await hooks.get('ariadne-connect')(h.$,{args:''});
  const poll = h.timer().callback;
  for (let at = 0; at <= 120000; at += 1000) {vi.setSystemTime(at);await poll();}
  expect(h.logs).toEqual([BACKGROUND_RETRY]);
  code = 'invalid_transition';vi.setSystemTime(121000);await poll();
  expect(h.logs).toEqual([BACKGROUND_RETRY,plainFailure(code,{reason})]);
});
it.each(['stale_generation','binding_mismatch','not_found'])('paused then removed (%s) stops the real loop with current urgent advice',async code => {
  vi.useFakeTimers();vi.setSystemTime(0);let removed = false;
  const h = host({handler:argv => argv[2] === 'claim' ? removed ? failure(code,code === 'not_found' ? {reason:'session_removed'} : undefined) : failure('invalid_transition',{reason:'owner_paused'}) : undefined});
  const hooks = hooksFor();await hooks.get('session.start')(h.$,{},async event => event);await hooks.get('ariadne-connect')(h.$,{args:''});
  const poll = h.timer().callback;await poll();removed = true;vi.setSystemTime(1000);await poll();
  expect(h.logs).toEqual([plainFailure('invalid_transition',{reason:'owner_paused'}),NOTICES.removed]);
  const calls = h.calls.length;await poll();expect(h.calls).toHaveLength(calls);
});
it('long lease refusal cannot age the first busy failure',async () => {
  vi.useFakeTimers();vi.setSystemTime(0);let busy = false;
  const h = host({handler:argv => argv[2] === 'claim' ? busy ? failure('store_busy') : failure('not_found',{reason:'lease_invalid'}) : undefined});
  const hooks = hooksFor();await hooks.get('session.start')(h.$,{},async event => event);await hooks.get('ariadne-connect')(h.$,{args:''});
  const poll = h.timer().callback;
  for (let at = 0; at <= 600000; at += 1000) {vi.setSystemTime(at);await poll();}
  expect(h.logs).toEqual([]);busy = true;
  for (let at = 601000; at < 721000; at += 1000) {vi.setSystemTime(at);await poll();expect(h.logs).toEqual([]);}
  vi.setSystemTime(721000);await poll();expect(h.logs).toEqual([BACKGROUND_RETRY]);
});
it('retries rejected startup qualification at heartbeat cadence and recovers intake without an owner command',async () => {
  vi.useFakeTimers();vi.setSystemTime(0);let rejected = true;
  const h = host({handler:argv => {if (argv[1] === '--version' && rejected) throw new Error('Private diagnostic');}});
  h.store.set(`binding:${binding.external_session_id}`,{project_id:ids.project,session_id:ids.session,saved_at:'2026-01-01T00:00:00.000Z'});
  const hooks = hooksFor();await hooks.get('session.start')(h.$,{},async event => event);
  const beat = h.timers().find(timer => timer.ms === 30000).callback;
  expect(h.timer()).toBe(null);
  for (let at = 30000; at <= 120000; at += 30000) {vi.setSystemTime(at);await beat();expect(h.logs).toEqual(at < 120000 ? [] : [BACKGROUND_RETRY]);}
  rejected = false;await beat();expect(h.timer()).not.toBe(null);
  await h.timer().callback();expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(1);
  // Qualification stops calling once it succeeds. Its one actual OK therefore
  // clears sticky transient health through idle expiry, not invented successes.
  for (let at = 150000; at <= 240000; at += 30000) {vi.setSystemTime(at);await beat();}
  await vi.waitFor(() => expect(h.store.get('hook-log')).toContainEqual(expect.objectContaining({step:'health',outcome:'recovered',code:'ok'})));
});

const coreCodes = JSON.parse(readFileSync(new URL('../../../contracts/generated/core/CoreErrorCode.schema.json',import.meta.url),'utf8')).enum;
it.each(coreCodes)('preserves canonical diagnostic code %s',async code => {
  const h = host(), health = conversationHealth();
  health.record(h.$,'announce',backgroundOutcome(noticeError(code),'Open Ariadne.'));
  await vi.waitFor(() => expect(h.store.get('hook-log')).toContainEqual(expect.objectContaining({code})));
});
it.each(['get','set'])('hung diagnostic store.%s never holds the claim poll or terminal callback',async method => {
  let code = 'store_busy';const h = host({handler:argv => argv[2] === 'claim' ? failure(code) : undefined});
  const hooks = hooksFor();await hooks.get('session.start')(h.$,{},async event => event);await hooks.get('ariadne-connect')(h.$,{args:''});
  const held = deferred(), original = h.$.store[method];h.$.store[method] = (key,...args) => key.endsWith('-log') ? held.promise : original(key,...args);
  try {await h.timer().callback();code = 'stale_generation';await h.timer().callback();expect(h.logs).toEqual([NOTICES.removed]);expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(2);}
  finally {held.resolve();}
});
it('bounds queued background records while storage hangs and leaves owner writes independent',async () => {
  const h = host(), held = deferred(), original = h.$.store.get;let first = true;
  h.$.store.get = async key => {if (key === 'hook-log' && first) {first = false;await held.promise;}return original(key);};
  try {
    for (let i = 0; i < 50; i += 1) backgroundDiagnostic(h.$,{step:'claim',outcome:'changed',code:'unsupported',at:`record-${i}`});
    await connectDiagnostic(h.$,{operation_id:'retained-operation',step:'connect',outcome:'ok'});
    expect(h.store.get('connect-log')).toEqual([{operation_id:'retained-operation',step:'connect',outcome:'ok'}]);
  } finally {held.resolve();}
  await vi.waitFor(() => expect(h.store.get('hook-log')?.map(record => record.at)).toEqual(Array.from({length:20},(_,i) => `record-${i + 30}`)));
});
it('deduplicates equal future-code advice without recording untrusted code text',async () => {
  vi.useFakeTimers();vi.setSystemTime(0);const h = host(), health = conversationHealth();
  for (let at = 0; at <= 120000; at += 30000) {
    vi.setSystemTime(at);health.record(h.$,'announce',backgroundOutcome(noticeError(at < 60000 ? 'future_one' : 'future_two'),'Update Ariadne.'));
  }
  expect(h.logs).toEqual(['Update Ariadne.']);
  await vi.waitFor(() => expect(h.store.get('hook-log')).toHaveLength(1));
  expect(h.store.get('hook-log').map(record => record.code)).toEqual(['protocol_error']);
});
it('separates bounded background diagnostics from owner history and drops untrusted codes',async () => {
  const h = host(), ownerRecords = Array.from({length:20},(_,i) => ({operation_id:`operation-${i}`,step:'connect',outcome:'ok'}));
  h.store.set('connect-log',ownerRecords);h.store.set('hook-log',Array.from({length:20},() => ({step:'announce',outcome:'recovered'})));
  let time = 0;
  const health = conversationHealth(() => time);
  health.record(h.$,'announce',backgroundOutcome(noticeError('private-session-name'),'Update Ariadne.'));
  health.record(h.$,'claim',backgroundOutcome(noticeError('private-session-name'),'Update Ariadne.'));
  await vi.waitFor(() => expect(h.store.get('hook-log').at(-1)?.code).toBe('protocol_error'));
  expect(h.store.get('hook-log')).toHaveLength(20);expect(h.store.get('connect-log')).toEqual(ownerRecords);
  expect(JSON.stringify(h.store.get('hook-log'))).not.toContain('private-session-name');
  h.$.store.get = async () => {throw new Error('storage unavailable');};
  // protocol_error is generic, so it speaks after the grace, storage failures notwithstanding.
  for (time = 0; time <= 120000; time += 30000) health.record(h.$,'helper',backgroundOutcome(noticeError('private-session-name'),'Update Ariadne.'));
  expect(h.logs).toEqual(['Update Ariadne.']);
});
