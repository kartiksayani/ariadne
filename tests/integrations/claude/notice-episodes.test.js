import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRegister } from '../../../integrations/claude/plugin/hooks/register.js';
import { claimLoop, NOTICES } from '../../../integrations/claude/plugin/hooks/claims.js';
import { readFileSync } from 'node:fs';
import { BACKGROUND_RETRY, connectDiagnostic, failureCode, ModError, noticeEpisodes, plainFailure } from '../../../integrations/claude/plugin/hooks/contracts.js';
import { qualify, setup } from '../../../integrations/claude/plugin/hooks/setup.js';
import { announcements } from '../../../integrations/claude/plugin/hooks/discovery.js';
import { binding, deferred, descriptor, failure, host, ids, prepared, status, success } from './fixtures.js';

const heartbeatRetry = BACKGROUND_RETRY;
const permissionDenied = plainFailure('permission_denied');
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
  ...['ENOENT','EACCES','EPERM','ENOEXEC','ENOTDIR','EISDIR','ELOOP','ENAMETOOLONG'].map(code => ({name:`broken helper ${code}`,steps:steps(3,`spawn:${code}`),immediate:true,notices:1})),
  {name:'temporary spawn exhaustion',steps:steps(21,'spawn:EAGAIN'),notices:1},
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
const reportRows = [
  {name:'success only',events:[[0,'start',null,0],[30000,'flush',null,0]]},
  {name:'transient blip',events:[[0,'start','io_error',0],[30000,'flush',null,0],[60000,'flush',null,0],[90000,'flush',null,0]]},
  {name:'alternating transient codes and rejected process',events:[[0,'start','store_busy',0],[60000,'flush','timeout',0],[119999,'flush','rejection',0],[120000,'flush','io_error',1],[600000,'flush','store_busy',1]]},
  {name:'long failure, real saves recover, second long failure',events:[[0,'start','host_unreachable',0],[120000,'flush','host_unreachable',1],[130000,'flush',null,1],[140000,'finish',null,1],[150000,'finish',null,1],[180000,'finish','io_error',1],[299999,'flush','io_error',1],[300000,'flush','io_error',2]]},
  {name:'idle drains do not rearm the same meaning',line:permissionDenied,events:[[0,'start','permission_denied',1],[1000,'flush',null,1],[2000,'finish','permission_denied',1],[3000,'flush',null,1],[4000,'flush',null,1],[5000,'flush',null,1],[6000,'finish','permission_denied',1]]},
  {name:'three nonempty successful flushes rearm the same meaning after the shared cap',line:permissionDenied,events:[[0,'start','permission_denied',1],[1000,'flush',null,1],[2000,'finish',null,1],[3000,'finish',null,1],[4000,'finish','permission_denied',1],[119999,'flush','permission_denied',1],[124000,'flush','permission_denied',2]]},
  {name:'held report save gives the actual recovery advice',line:plainFailure('invalid_transition',{reason:'recovery_required'}),events:[[0,'start',['invalid_transition',{reason:'recovery_required'}],1],[1000,'flush',['invalid_transition',{reason:'recovery_required'}],1]]},
  {name:'changed report advice waits for stability and cap, then may return to the original advice',events:[
    [0,'start','permission_denied',[permissionDenied]],
    [1000,'flush',['invalid_transition',{reason:'recovery_required'}],[permissionDenied]],
    [11000,'flush',['invalid_transition',{reason:'recovery_required'}],[permissionDenied]],
    [120000,'flush',['invalid_transition',{reason:'recovery_required'}],[permissionDenied,plainFailure('invalid_transition',{reason:'recovery_required'})]],
    [121000,'flush','permission_denied',[permissionDenied,plainFailure('invalid_transition',{reason:'recovery_required'})]],
    [131000,'flush','permission_denied',[permissionDenied,plainFailure('invalid_transition',{reason:'recovery_required'})]],
    [240000,'flush','permission_denied',[permissionDenied,plainFailure('invalid_transition',{reason:'recovery_required'}),permissionDenied]],
  ]},
  {name:'changed installation failure prints immediately',line:permissionDenied,events:[[0,'start','permission_denied',1],[1000,'flush','incompatible_adapter',[permissionDenied,mismatch]],[2000,'flush','incompatible_adapter',[permissionDenied,mismatch]]]},
  ...['ENOENT','EACCES'].map(code => ({name:`broken helper ${code} speaks immediately`,line:mismatch,events:[[0,'start',`spawn:${code}`,1],[1000,'flush',`spawn:${code}`,1],[600000,'flush',`spawn:${code}`,1]]})),
];
it.each(reportRows)('report-save episode: $name',async row => {
  vi.useFakeTimers();vi.setSystemTime(0);
  const value = await prepared(), submission = deferred();let code = null;
  const h = host({claim:value,submit:() => submission.promise,handler:argv => {
    if (argv[2] !== 'report' || !code) return;
    if (Array.isArray(code)) return failure(...code);
    if (code === 'rejection') throw new Error('Private fixture detail');
    if (code.startsWith('spawn:')) throw Object.assign(new Error('Private fixture detail'),{code:code.slice(6)});
    return failure(code);
  }});
  const loop = claimLoop(descriptor.helperPath,binding);
  await loop.poll(h.$);
  for (const [time,action,outcome,count] of row.events) {
    vi.setSystemTime(time);code = outcome;
    if (action === 'start') await loop.start(h.$,{text:value.formatted_payload,turnId:'report-turn'});
    else if (action === 'finish') await loop.complete(h.$,{turnId:'report-turn',answer:`Answer ${time}`,reason:'answer',isAborted:false});
    else await loop.drain(h.$);
    expect(h.logs.filter(line => !line.startsWith('Ariadne: turn.start carried'))).toEqual(Array.isArray(count) ? count : Array(count).fill(row.line ?? NOTICES.reports));
  }
});

it.each([0,1,3])('a partial report flush with %i saved records cannot rearm a failure notice',async saves => {
  vi.useFakeTimers();vi.setSystemTime(0);
  const value = await prepared(), submission = deferred();let remaining = 0;
  const h = host({claim:value,submit:() => submission.promise,handler:argv => {
    if (argv[2] === 'report' && remaining-- <= 0) return failure('permission_denied');
  }});
  const loop = claimLoop(descriptor.helperPath,binding);
  await loop.poll(h.$);await loop.start(h.$,{text:value.formatted_payload,turnId:'report-turn'});
  for (const answer of ['First answer','Second answer']) await loop.complete(h.$,{turnId:'report-turn',answer,reason:'answer',isAborted:false});
  expect(loop.status().pending_reports).toBe(4);
  remaining = saves;await loop.drain(h.$);
  expect(h.events).toHaveLength(saves);expect(loop.status().pending_reports).toBe(4 - saves);
  expect(h.logs.filter(line => !line.startsWith('Ariadne: turn.start carried'))).toEqual([permissionDenied]);
});

it('retiring a loop after one real report flush cannot hide the next live claim outage',async () => {
  vi.useFakeTimers();vi.setSystemTime(0);
  const value = await prepared(), submission = deferred(), notices = noticeEpisodes();
  let phase = 'report outage';
  const h = host({claim:value,submit:() => submission.promise,handler:argv => {
    if (phase === 'report outage' && argv[2] === 'report') return failure('host_unreachable');
    if (phase === 'claim outage' && argv[2] === 'claim') return failure('store_busy');
  }});
  const old = claimLoop(descriptor.helperPath,binding,{notices:notices.fork()});
  await old.poll(h.$);await old.start(h.$,{text:value.formatted_payload,turnId:'retired-turn'});
  expect(old.status().pending_reports).toBe(2);
  vi.setSystemTime(120000);await old.drain(h.$);
  const visible = () => h.logs.filter(line => !line.startsWith('Ariadne: turn.start carried'));
  expect(visible()).toEqual([BACKGROUND_RETRY]);
  expect(old.status().pending_reports).toBe(2);
  phase = 'healthy';await old.drain(h.$);
  expect(old.status().pending_reports).toBe(0);
  expect(h.events.map(event => event.kind)).toEqual(['accepted','turn_started']);
  await old.stop(h.$);
  expect(old.status()).toMatchObject({stopped:true,pending_reports:0});
  phase = 'claim outage';
  const live = claimLoop(descriptor.helperPath,binding,{notices:notices.fork()});
  vi.setSystemTime(121000);await live.poll(h.$);
  vi.setSystemTime(240999);await live.poll(h.$);
  expect(visible()).toEqual([BACKGROUND_RETRY]);
  vi.setSystemTime(241000);await live.poll(h.$);
  expect(visible()).toEqual([BACKGROUND_RETRY,BACKGROUND_RETRY]);
  expect(live.status().pending_reports).toBe(0);
});

const outageSlots = ['announce','helper','claim','auto'];
const permanentSpawns = ['ENOENT','EACCES','EPERM','ENOEXEC','ENOTDIR','EISDIR','ELOOP','ENAMETOOLONG'];
const installFailures = [
  ...permanentSpawns.map(code => ({name:`helper spawn ${code}`,error:() => Object.assign(new Error('Private fixture detail'),{code})})),
  {name:'wrapped helper spawn ENOENT',error:() => new Error('Private fixture detail',{cause:Object.assign(new Error('Private fixture detail'),{code:'ENOENT'})})},
  {name:'typed I/O wrapping a missing helper',error:() => Object.assign(noticeError('io_error'),{cause:Object.assign(new Error('Private fixture detail'),{code:'ENOENT'})})},
  {name:'missing installed resource',error:() => noticeError('incompatible_adapter')},
  {name:'helper version mismatch',error:() => noticeError('incompatible_adapter')},
];
it.each(installFailures)('$name speaks immediately once across every slot and fork during a shown app outage',async ({error}) => {
  vi.useFakeTimers();vi.setSystemTime(0);
  const h = host(), notices = noticeEpisodes(), unreachable = noticeError('host_unreachable');
  notices.fail(h.$,'announce',unreachable,heartbeatRetry);
  vi.setSystemTime(120000);notices.fail(h.$,'announce',unreachable,heartbeatRetry);
  expect(h.logs).toEqual([heartbeatRetry]);
  for (const slot of [...outageSlots,'qualification','reports']) {
    const member = notices.fork();
    const since = Date.now();
    for (const offset of [1000,2000,600000]) {
      vi.setSystemTime(since + offset);member.fail(h.$,slot,error(),mismatch,heartbeatRetry);
      expect(h.logs).toEqual([heartbeatRetry,mismatch]);
    }
    expect(failureCode(error())).toBe('incompatible_adapter');
    expect(h.logs).toEqual([heartbeatRetry,mismatch]);
  }
});
it.each(['descriptor','version','truncated version'])('local qualification %s failure bypasses a shown retry immediately',async cause => {
  vi.useFakeTimers();vi.setSystemTime(0);
  const h = host({handler:argv => argv[1] === '--version' ? {
    exitCode:0,stdout:cause === 'version' ? 'ariadne 0.0.0\n' : `ariadne ${descriptor.appVersion}\n`,
    isStdoutTruncated:cause === 'truncated version',
  } : undefined});
  const notices = noticeEpisodes();
  notices.fail(h.$,'announce',noticeError('store_busy'),heartbeatRetry);
  vi.setSystemTime(120000);notices.fail(h.$,'announce',noticeError('store_busy'),heartbeatRetry);
  vi.setSystemTime(121000);
  let caught;
  try {await qualify(h.$,cause === 'descriptor' ? null : descriptor);} catch (error) {caught = error;}
  expect(caught).toBeInstanceOf(ModError);
  expect(failureCode(caught)).toBe('incompatible_adapter');
  for (const slot of [...outageSlots,'reports']) notices.fail(h.$,slot,caught,caught.plain,heartbeatRetry);
  expect(h.logs).toEqual([heartbeatRetry,mismatch]);
});

it.each(['store_busy','timeout','io_error','process_rejected','host_unreachable','EAGAIN','EMFILE','EPIPE'])('genuine transient %s keeps its full grace in every slot',async code => {
  vi.useFakeTimers();
  for (const slot of [...outageSlots,'qualification','reports']) {
    vi.setSystemTime(0);
    const h = host(), notices = noticeEpisodes();
    const error = ['EAGAIN','EMFILE','EPIPE'].includes(code)
      ? Object.assign(new Error('Private fixture detail'),{code}) : noticeError(code);
    for (const time of [0,119999,120000,600000]) {
      vi.setSystemTime(time);notices.fail(h.$,slot,error,mismatch,heartbeatRetry);
      expect(h.logs).toEqual(time < 120000 ? [] : [heartbeatRetry]);
    }
  }
});
it.each(['ENOENT','EACCES','incompatible_adapter'])('owner connect still answers immediately for %s after a shown outage',async code => {
  vi.useFakeTimers();vi.setSystemTime(0);let outcome = null;
  const h = host({handler:argv => {
    if (argv[1] === '--version' || outcome === null) return;
    if (outcome === 'host_unreachable' || outcome === 'incompatible_adapter') return failure(outcome);
    throw Object.assign(new Error('Private fixture detail'),{code:outcome});
  }});
  const hooks = hooksFor();await hooks.get('session.start')(h.$,{},async event => event);
  const beat = h.timers().find(timer => timer.ms === 30000).callback;
  outcome = 'host_unreachable';await beat();vi.setSystemTime(120000);await beat();
  expect(h.logs).toEqual([heartbeatRetry]);outcome = code;
  const text = code === 'incompatible_adapter' ? mismatch : connectFailure;
  for (let i = 0; i < 3; i += 1) {
    expect((await hooks.get('ariadne-connect')(h.$,{args:ids.session})).text).toBe(`That did not complete. ${text}`);
    expect(h.logs).toEqual([heartbeatRetry,text]);
  }
});
const publicationFailures = ['ENOENT','EACCES','incompatible_adapter','store_busy','timeout','io_error','process_rejected','host_unreachable','EAGAIN','EMFILE'];
const publicationRows = ['bound announce','status'].flatMap(stage => publicationFailures.map(code => ({stage,code})));
it.each(publicationRows)('$stage preserves $code through the saved-binding wrapper',async ({stage,code}) => {
  vi.useFakeTimers();vi.setSystemTime(0);
  const permanent = ['ENOENT','EACCES','incompatible_adapter'].includes(code);
  const h = host({handler:(argv,options) => {
    const bound = argv[2] === 'announce' && JSON.parse(options.stdin).binding_scope !== null;
    if (!(stage === 'bound announce' ? bound : argv[2] === 'connection-status')) return;
    if (code.startsWith('E')) throw Object.assign(new Error('Private fixture detail'),{code});
    if (code === 'process_rejected') throw new Error('Private fixture detail');
    return failure(code);
  }});
  const discovery = announcements(descriptor), notices = noticeEpisodes();
  const owner = setup(descriptor.helperPath,(h,binding) => discovery.announce(h,{binding_id:binding.binding_id,generation:binding.generation}),{waitMs:0,pollMs:0});
  for (const time of [0,119999,120000,600000]) {
    vi.setSystemTime(time);
    const error = await owner.connect(h.$,ids.session,{background:true}).then(() => null,error => error);
    if (time === 0) expect(error).toBeInstanceOf(ModError);
    expect(failureCode(error)).toBe(permanent ? 'incompatible_adapter' : code.startsWith('E') ? 'process_rejected' : code);
    if (permanent && time === 0) expect(error.plain).toBe(mismatch);
    notices.fail(h.$,'auto',error,error.plain,heartbeatRetry);
    expect(h.logs).toEqual(permanent ? [mismatch] : time < 120000 ? [] : [heartbeatRetry]);
  }
});
const otherTransients = ['io_error','store_busy','timeout','process_rejected'];
const outageChanges = outageSlots.flatMap(slot => otherTransients.map(code => ({slot,code})));
const retryFor = () => BACKGROUND_RETRY;
function noticeError(code) {
  if (code === 'process_rejected') return new Error('Private fixture detail');
  const error = new ModError('Private fixture detail');error.code = code;return error;
}

it.each(outageChanges)('$slot keeps one truthful retry through a shown outage changing to $code',async ({slot,code}) => {
  vi.useFakeTimers();vi.setSystemTime(0);
  const h = host(), notices = noticeEpisodes(), member = slot === 'claim' ? notices.fork() : notices;
  const reporter = slot === 'announce' ? 'helper' : 'announce', unreachable = noticeError('host_unreachable');
  notices.fail(h.$,reporter,unreachable,heartbeatRetry);member.fail(h.$,slot,unreachable,retryFor(slot));
  vi.setSystemTime(120000);notices.fail(h.$,reporter,unreachable,heartbeatRetry);member.fail(h.$,slot,unreachable,retryFor(slot));
  expect(h.logs).toEqual([heartbeatRetry]);
  for (let i = 0; i < 3; i += 1) notices.good(h.$,reporter);
  for (const time of [121000,240999,241000,3600000]) {
    vi.setSystemTime(time);member.fail(h.$,slot,noticeError(code),retryFor(slot));
    expect(h.logs).toEqual([heartbeatRetry]);
  }
});

it.each(outageChanges)('$slot with a shown $code retry joins an already-shown outage',async ({slot,code}) => {
  vi.useFakeTimers();vi.setSystemTime(0);
  const h = host(), notices = noticeEpisodes(), member = slot === 'claim' ? notices.fork() : notices;
  const reporter = slot === 'announce' ? 'helper' : 'announce', unreachable = noticeError('host_unreachable');
  member.fail(h.$,slot,noticeError(code),retryFor(slot));
  vi.setSystemTime(120000);member.fail(h.$,slot,noticeError(code),retryFor(slot));
  expect(h.logs).toEqual([retryFor(slot)]);
  for (const time of [121000,600000]) {
    vi.setSystemTime(time);member.fail(h.$,slot,unreachable,retryFor(slot));notices.fail(h.$,reporter,unreachable,heartbeatRetry);
    expect(h.logs).toEqual([retryFor(slot)]);
  }
});

it.each(outageSlots)('%s keeps a shown retry quiet after a silent lease refusal',async slot => {
  vi.useFakeTimers();vi.setSystemTime(0);
  const h = host(), notices = noticeEpisodes(), member = slot === 'claim' ? notices.fork() : notices;
  member.fail(h.$,slot,noticeError('host_unreachable'),retryFor(slot));
  vi.setSystemTime(120000);member.fail(h.$,slot,noticeError('host_unreachable'),retryFor(slot));
  expect(h.logs).toEqual([retryFor(slot)]);
  const lease = noticeError('not_found');lease.details = {reason:'lease_invalid'};
  vi.setSystemTime(121000);member.fail(h.$,slot,lease,null);
  for (const time of [600000,719999,720000,3600000]) {
    vi.setSystemTime(time);member.fail(h.$,slot,noticeError('store_busy'),retryFor(slot));
    expect(h.logs).toEqual([retryFor(slot)]);
  }
});

it.each([false,true])('one ten-minute app outage across slots, owner command: %s',async command => {
  vi.useFakeTimers();vi.setSystemTime(0);let down = false;
  const h = host({handler:argv => down && argv[1] !== '--version' && argv[2] !== 'report' ? failure('host_unreachable') : undefined});
  const hooks = hooksFor();
  await hooks.get('session.start')(h.$,{},async event => event);
  await hooks.get('ariadne-connect')(h.$,{args:''});down = true;
  const beat = h.timers().find(timer => timer.ms === 30000).callback;
  const poll = h.timer().callback;
  for (let time = 0; time <= 600000; time += 1000) {
    vi.setSystemTime(time);
    if (time % 30000 === 0) await beat();
    await poll();
    if (command && [60000,300000].includes(time)) expect((await hooks.get('ariadne-status')(h.$)).text).toContain("Ariadne can't be reached");
    expect(h.logs).toEqual(time < 120000 ? [] : [heartbeatRetry]);
  }
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

it.each(['recover','conversation change'])('shared outage survives local report saves and rearms after %s',async reset => {
  vi.useFakeTimers();vi.setSystemTime(0);
  const h = host(), notices = noticeEpisodes();let claims = notices.fork();
  const error = new ModError('Fixture outage');error.code = 'host_unreachable';
  const fail = () => {
    for (const slot of ['announce','helper','auto']) notices.fail(h.$,slot,error,heartbeatRetry);
    claims.fail(h.$,'claim',error,NOTICES.failure);
  };
  fail();vi.setSystemTime(120000);fail();expect(h.logs).toEqual([heartbeatRetry]);
  // Reports are local saves, so even sustained report success cannot reset an app outage.
  for (let i = 0; i < 3; i += 1) claims.good(h.$,'reports');
  for (let i = 0; i < 2; i += 1) {
    for (const slot of ['announce','helper','auto']) notices.good(h.$,slot);
    claims.good(h.$,'claim');
  }
  fail();expect(h.logs).toEqual([heartbeatRetry]);
  if (reset === 'recover') for (let i = 0; i < 3; i += 1) {
    for (const slot of ['announce','helper','auto']) notices.good(h.$,slot);
    claims.good(h.$,'claim');
  }
  else {notices.reset();claims = notices.fork();}
  vi.setSystemTime(180000);fail();expect(h.logs).toEqual([heartbeatRetry]);
  vi.setSystemTime(300000);fail();expect(h.logs).toEqual([heartbeatRetry,heartbeatRetry]);
});

it.each(['disconnected','not_found','stale_generation','binding_mismatch'])('recovering an old claim (%s) cannot swallow the next app outage',async retirement => {
  vi.useFakeTimers();vi.setSystemTime(0);let phase = 'healthy', statusSeen = false;
  const h = host({handler:argv => {
    if (argv[1] === '--version' || argv[2] === 'report') return;
    if (phase === 'down' || phase === 'recover' && argv[2] === 'claim') return failure('host_unreachable');
    if (phase === 'recover' && argv[2] === 'connection-status' && !statusSeen) {
      statusSeen = true;
      return retirement === 'disconnected' ? success({...status,connection_state:'disconnected',dispatch_state:'disconnected'}) : failure(retirement);
    }
  }});
  const hooks = hooksFor();await hooks.get('session.start')(h.$,{},async event => event);
  await hooks.get('ariadne-connect')(h.$,{args:''});
  const beat = h.timers().find(timer => timer.ms === 30000).callback, poll = h.timer().callback;
  phase = 'down';await beat();await poll();vi.setSystemTime(120000);await beat();await poll();
  expect(h.logs).toEqual([heartbeatRetry]);
  phase = 'recover';expect((await hooks.get('ariadne-connect')(h.$,{args:''})).text).toContain('connected to Ariadne');
  expect(statusSeen).toBe(true);phase = 'healthy';
  for (let i = 0; i < 3; i += 1) {await beat();await poll();}
  phase = 'down';vi.setSystemTime(180000);await beat();await poll();
  vi.setSystemTime(300000);await beat();await poll();
  expect(h.logs).toEqual([heartbeatRetry,heartbeatRetry]);
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

const coreCodes = JSON.parse(readFileSync(new URL('../../../contracts/generated/core/CoreErrorCode.schema.json',import.meta.url),'utf8')).enum;
it.each(coreCodes)('preserves canonical diagnostic code %s',async code => {
  const h = host(), notices = noticeEpisodes();
  const error = new ModError('Private fixture detail');error.code = code;
  notices.fail(h.$,'announce',error,'Open Ariadne.');
  await vi.waitFor(() => expect(h.store.get('hook-log')).toContainEqual(expect.objectContaining({code})));
});

describe.each(['heartbeat','claim'])('%s notice episode invariant', source => {
  it.each(rows)('$name',async row => {
    vi.useFakeTimers();vi.setSystemTime(0);
    let outcome = null;
    const h = host({handler:argv => {
      if (argv[2] !== (source === 'heartbeat' ? 'announce' : 'claim') || outcome === null) return;
      if (outcome === 'rejection') throw new Error('private session content must never be logged');
      if (outcome.startsWith('spawn:')) throw Object.assign(new Error('Private fixture detail'),{code:outcome.slice(6)});
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
// Stable changed advice waits for debounce and the shared cap; urgent advice
// remains immediate. Complete transcripts pin the full transition sequence.
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
    [121000,'invalid_transition',reason,[NOTICES.failure]],
    [122000,'invalid_transition',reason,[NOTICES.failure]],
    [131000,'invalid_transition',reason,[NOTICES.failure]],
    [239999,'invalid_transition',reason,[NOTICES.failure]],
    [240000,'invalid_transition',reason,[NOTICES.failure,NOTICES[reason] ?? NOTICES.blocked]],
  ]})),
  ...['claim','heartbeat'].map(source => ({name:`retry shown then version mismatch (${source})`,source,events:[
    [0,'host_unreachable',undefined,[]],[120000,'host_unreachable',undefined,[source === 'claim' ? NOTICES.failure : heartbeatRetry]],
    [121000,'incompatible_adapter',undefined,[source === 'claim' ? NOTICES.failure : heartbeatRetry,mismatch]],
    [122000,'incompatible_adapter',undefined,[source === 'claim' ? NOTICES.failure : heartbeatRetry,mismatch]],
  ]})),
  ...[['not_found',autoGone],['binding_conflict',autoConflict]].map(([code,text]) => ({name:`auto closed then ${code}`,source:'auto',events:[
    [0,'invalid_transition','session_closed',[autoClosed]],
    ...code === 'not_found' ? [[30000,code,undefined,[autoClosed,text]],[60000,code,undefined,[autoClosed,text]]] : [
      [30000,code,undefined,[autoClosed]],[40000,code,undefined,[autoClosed]],
      [119999,code,undefined,[autoClosed]],[120000,code,undefined,[autoClosed,text]],
    ],
  ],terminal:code === 'not_found'})),
  {name:'transient then paused then transient gets fresh grace',source:'claim',events:[
    [0,'host_unreachable',undefined,[]],[120000,'host_unreachable',undefined,[NOTICES.failure]],
    [121000,'invalid_transition','owner_paused',[NOTICES.failure]],
    [131000,'invalid_transition','owner_paused',[NOTICES.failure]],
    [240000,'invalid_transition','owner_paused',[NOTICES.failure,NOTICES.owner_paused]],
    [241000,'store_busy',undefined,[NOTICES.failure,NOTICES.owner_paused]],
    [360999,'io_error',undefined,[NOTICES.failure,NOTICES.owner_paused]],
    [361000,'timeout',undefined,[NOTICES.failure,NOTICES.owner_paused,NOTICES.failure]],
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

it('deduplicates equal future-code advice without recording untrusted code text',async () => {
  vi.useFakeTimers();vi.setSystemTime(0);
  const h = host(), notices = noticeEpisodes();
  for (const [time,code] of [[0,'future_one'],[1000,'future_one'],[2000,'future_two'],[12000,'future_two'],[120000,'future_two']]) {
    vi.setSystemTime(time);
    const error = new ModError('Private detail');error.code = code;
    notices.fail(h.$,'announce',error,'Update Ariadne.');
    expect(h.logs).toEqual(['Update Ariadne.']);
  }
  expect(h.logs).toEqual(['Update Ariadne.']);
  await vi.waitFor(() => expect(h.store.get('hook-log')).toHaveLength(1));
  expect(h.store.get('hook-log').map(record => record.code)).toEqual(['protocol_error']);
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
  expect(h.logs).toEqual(['Update Ariadne.']);
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
