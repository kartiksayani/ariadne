import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRegister } from '../../../integrations/claude/plugin/hooks/register.js';
import { claimLoop } from '../../../integrations/claude/plugin/hooks/claims.js';
import { BACKGROUND_RETRY, TURN_FAILURE, conversationHealth, plainFailure } from '../../../integrations/claude/plugin/hooks/contracts.js';
import { binding, deferred, descriptor, failure, host, ids, prepared, success } from './fixtures.js';
import { balanced, resetLedgers } from './ledger.js';

// Fixed cases for the liveness rule in the README: a producer counts from its
// first outcome until it is retired, each call records one outcome, and a call
// still open after its producer's helper runs (ten seconds for one) counts as a
// temporary timeout until it ends.
//
// Every conversation health the plugin builds is wrapped here (ledger.js), so
// the calls each producer opens are counted from the outside against the
// outcomes they settle with.
vi.mock('../../../integrations/claude/plugin/hooks/contracts.js',async importOriginal => {
  const actual = await importOriginal(), {trackedHealth} = await import('./ledger.js');
  return {...actual,conversationHealth:(...args) => trackedHealth(actual.conversationHealth(...args))};
});
const MINUTE = 60000;
const PAUSED = plainFailure('invalid_transition',{reason:'owner_paused'});
const GONE = 'Ariadne: the Ariadne session for this conversation no longer exists. Run /ariadne-connect to connect again.';
const ELSEWHERE = 'This Ariadne session is connected to another conversation.';
const next = async event => event;
function callbacks() {
  const hooks = new Map();
  createRegister(descriptor,{waitMs:0,pollMs:0})((name,pattern,handler) => {
    if (typeof pattern === 'function') {handler = pattern;pattern = null;}
    hooks.set(pattern?.command ?? name,pattern?.command ? ($,event = {args:''}) => handler($,event) : handler);
  });
  return hooks;
}
const remembered = () => new Map([[`binding:${binding.external_session_id}`,{project_id:ids.project,session_id:ids.session,saved_at:'2026-01-01T00:00:00.000Z'}]]);
afterEach(() => {vi.restoreAllMocks();resetLedgers();});

describe('liveness: calls that have nothing to report still record an outcome',() => {
  // Blocking 1: a heartbeat with nothing to drain is an automatic-reconnect call.
  it.each([['not_found',GONE],['binding_conflict',ELSEWHERE]])('a shown automatic-reconnect %s line never hides later paused advice',async (code,line) => {
    let time = 0, refuse = true, paused = false;
    vi.spyOn(Date,'now').mockImplementation(() => time);
    const h = host({store:remembered(),handler:argv => {
      if (refuse && argv[1] === 'binding' && argv[2] === 'connect') return failure(code);
      if (paused && argv[2] === 'claim') return failure('invalid_transition',{reason:'owner_paused'});
    }});
    const hooks = callbacks();
    await hooks.get('session.start')(h.$,{},next);
    await vi.waitFor(() => expect(h.logs).toEqual([line]));
    refuse = false;
    await hooks.get('ariadne-connect')(h.$,{args:ids.session});
    const beat = h.timers().find(timer => timer.ms === 30000), tick = h.timer();
    for (time = 30000; time <= 5 * MINUTE; time += 30000) {await beat.callback();await tick.callback();}
    paused = true;time += 1000;await tick.callback();
    expect(h.logs).toEqual([line,PAUSED]);
    await hooks.get('session.end')(h.$,{},next);
    await balanced();
  });
  // Blocking 2: polls that find a claim already active are claim calls too.
  it('one claim blip then a delivered message prints nothing during the healthy turn',async () => {
    let time = 0, blip = true;
    const value = await prepared(), submission = deferred();
    const h = host({claim:value,submit:() => submission.promise,handler:argv => blip && argv[2] === 'claim' ? failure('host_unreachable') : undefined});
    const loop = claimLoop(descriptor.helperPath,binding,{now:() => time,health:conversationHealth(() => time)});
    await loop.poll(h.$);
    blip = false;time = 1000;await loop.poll(h.$);
    expect(h.prompts).toHaveLength(1);
    submission.resolve({text:value.formatted_payload});
    await loop.start(h.$,{text:value.formatted_payload,turnId:'healthy-turn'});
    for (time = 2000; time <= 4 * MINUTE; time += 1000) await loop.poll(h.$);
    expect(h.events.map(event => event.kind)).toEqual(['accepted','turn_started']);
    expect(h.logs.filter(text => !text.startsWith('Ariadne: turn.start carried'))).toEqual([]);
    await loop.complete(h.$,{turnId:'healthy-turn',answer:'done',reason:'answer',isAborted:false});
    await loop.stop(h.$);
    await balanced();
  });
  // The helper producer only records on turn callbacks, so its last failure would
  // stay current in an idle conversation until the binding ended it.
  it('a helper failure is retired when its binding ends: no stale line stays current and nothing prints after',async () => {
    let time = 0;
    const h = host({claim:await prepared()}), health = conversationHealth(() => time);
    const loop = claimLoop(descriptor.helperPath,binding,{now:() => time,health});
    health.record(h.$,'helper',{kind:'transient',code:'timeout',text:BACKGROUND_RETRY});
    expect(health.current()).toMatchObject({kind:'transient',producer:'helper'});
    time = 30000;
    await loop.stop(h.$,true);
    expect(health.current()).toEqual({kind:'ok'});
    // Another producer's calls keep evaluating health; the old failure never speaks.
    for (time = 31000; time <= 10 * MINUTE; time += 1000) health.record(h.$,'auto',{kind:'ok'});
    expect(health.current()).toEqual({kind:'ok'});
    expect(h.logs).toEqual([]);
    await balanced();
  });
  // Long runs of polls with nothing to claim, nothing to save, or a claim
  // already active, while the app's answers change at random. Each poll's
  // report and claim calls settle exactly once, and a stale claim blip never
  // speaks over a healthy stretch.
  it('16 seeded real claim loops settle every call once and never print during healthy stretches',async () => {
    const value = await prepared();
    for (let seed = 1; seed <= 16; seed += 1) {
      let state = seed, time = 0, mode = 'idle', submission = deferred(), turns = 0;
      const rng = max => {state ^= state << 13;state ^= state >>> 17;state ^= state << 5;return (state >>> 0) % max;};
      const h = host({claim:value,submit:() => submission.promise,handler:argv => {
        if (argv[2] === 'claim') return mode === 'blip' ? failure('host_unreachable') : mode === 'paused' ? failure('invalid_transition',{reason:'owner_paused'}) : mode === 'idle' ? success(null) : undefined;
        if (argv[2] === 'report' && mode === 'blip') return failure('store_busy');
      }});
      const loop = claimLoop(descriptor.helperPath,binding,{now:() => time,health:conversationHealth(() => time)});
      for (let step = 0; step < 300; step += 1) {
        time += 1000;
        const roll = rng(100);
        // Mostly healthy, with one-poll blips and short paused stretches.
        mode = roll < 3 ? 'blip' : roll < 5 ? 'paused' : roll < 8 ? 'deliver' : 'idle';
        await loop.poll(h.$);
        const active = loop.status().active;
        if (active && rng(4) === 0) {
          submission.resolve({text:value.formatted_payload});
          const turnId = `turn-${seed}-${turns += 1}`;
          await loop.start(h.$,{text:value.formatted_payload,turnId});
          await loop.complete(h.$,{turnId,answer:'done',reason:'answer',isAborted:false});
          submission = deferred();
        }
      }
      // A blip is one poll, far short of the two-minute grace.
      expect(h.logs.filter(text => text === BACKGROUND_RETRY),`seed ${seed}`).toEqual([]);
      await loop.stop(h.$);
      await balanced();
    }
  });
});

describe('liveness: a hung call caps out',() => {
  // The routing note of an automatic reconnect never settles. The reconnect
  // never waits for its note: it is connected at once, stays healthy, holds
  // no owner command, and the tick never sends a second note while the first
  // is out.
  it('a reconnect whose routing note never settles is connected at once, prints no retry line, holds no owner command, and is sent once',async () => {
    let time = 0, down = false, appends = 0;
    vi.spyOn(Date,'now').mockImplementation(() => time);
    const note = deferred(), entered = deferred(), lines = [];
    const h = host({store:remembered(),append:() => {appends += 1;entered.resolve();return note.promise;},
      handler:argv => down && argv[2] === 'claim' ? failure('host_unreachable') : undefined});
    const log = h.$.ui.log;
    h.$.ui.log = text => {lines.push({at:time,text});log(text);};
    const hooks = callbacks();
    await hooks.get('session.start')(h.$,{},next);
    await entered.promise;
    await new Promise(resolve => setTimeout(resolve,0));
    // The reconnect call settled healthy with its note still out.
    await balanced();
    const reconnected = ['Ariadne: this conversation is connected to its Ariadne session again.'];
    expect(lines.map(line => line.text)).toEqual(reconnected);
    expect((await hooks.get('ariadne-connect')(h.$,{args:''})).text).toContain('This conversation is connected to Ariadne.');
    const sent = appends;
    const beat = h.timers().find(timer => timer.ms === 30000), tick = h.timer();
    for (time = 1000; time <= 4 * MINUTE; time += 1000) {
      await tick.callback();
      if (time % 30000 === 0) await beat.callback();
    }
    expect(appends).toBe(sent);
    expect(lines.map(line => line.text)).toEqual(reconnected);
    note.resolve({uuid:'late-row'});
    // A healthy connection, so a later outage gets its own full grace.
    down = true;
    const outage = time + 1000;
    for (time = outage; time < outage + 2 * MINUTE; time += 1000) await tick.callback();
    expect(lines.map(line => line.text)).toEqual(reconnected);
    await tick.callback();
    expect(lines.at(-1)).toEqual({at:outage + 2 * MINUTE,text:BACKGROUND_RETRY});
    down = false;
    await hooks.get('session.end')(h.$,{},next);
    await balanced();
  });
  it('a hung call counts as a timeout once it outlasts its producer\u2019s helper runs, until it settles, and a call settled after its producer retired records nothing',async () => {
    let time = 0;
    const lines = [], $ = {store:{get:async () => [],set:async () => {}},ui:{log:text => lines.push({at:time,text})}};
    const health = conversationHealth(() => time);
    // One helper run: ten seconds. A report flush (up to five saves): 42 s. An automatic reconnect (up to eight runs): 66 s.
    const hungs = {announce:health.call($,'announce'),reports:health.call($,'reports'),auto:health.call($,'auto')};
    for (time = 1000; time <= 10000; time += 1000) health.record($,'claim',{kind:'ok'});
    time = 10000;expect(health.current()).toEqual({kind:'ok'});
    time = 10001;health.record($,'claim',{kind:'ok'});
    expect(health.current()).toMatchObject({kind:'transient',code:'timeout',producer:'announce'});
    // The slow producers are not hung yet; settling the single-run call leaves them waiting.
    hungs.announce({kind:'ok'});
    time = 42000;health.record($,'claim',{kind:'ok'});expect(health.current()).toEqual({kind:'ok'});
    time = 42001;health.record($,'claim',{kind:'ok'});
    expect(health.current()).toMatchObject({kind:'transient',code:'timeout',producer:'reports'});
    hungs.reports({kind:'ok'});
    time = 66000;health.record($,'claim',{kind:'ok'});expect(health.current()).toEqual({kind:'ok'});
    time = 66001;health.record($,'claim',{kind:'ok'});
    expect(health.current()).toMatchObject({kind:'transient',code:'timeout',producer:'auto'});
    const hung = hungs.auto;
    // The outage began when the hang was first seen, so the grace runs from then.
    for (time = 67000; time <= 187000; time += 1000) health.record($,'claim',{kind:'ok'});
    expect(lines).toEqual([{at:187000,text:BACKGROUND_RETRY}]);
    hung({kind:'ok'});
    expect(health.current()).toEqual({kind:'ok'});
    // Retiring a producer closes its open calls: their late outcomes record nothing.
    const late = health.call($,'reports');
    health.retire($,'reports');
    late({kind:'held',code:'permission_denied',text:plainFailure('permission_denied')});
    expect(health.current()).toEqual({kind:'ok'});
    expect(lines).toHaveLength(1);
    // No time-based expiry: a failure stays current until its producer calls again or retires.
    health.record($,'helper',{kind:'held',code:'permission_denied',text:plainFailure('permission_denied')});
    time += 24 * 60 * MINUTE;health.record($,'claim',{kind:'ok'});
    expect(health.current()).toMatchObject({kind:'held',producer:'helper'});
    health.retire($,'helper');
    expect(health.current()).toEqual({kind:'ok'});
    await balanced();
  });
  // A turn callback is not run again: hung, it shows the turn callback's own line, never the promise to keep trying.
  it('a hung turn callback counts after its two helper runs and shows the turn callback’s line, not the retry line',async () => {
    let time = 0;
    const lines = [], $ = {store:{get:async () => [],set:async () => {}},ui:{log:text => lines.push({at:time,text})}};
    const health = conversationHealth(() => time);
    const hung = health.call($,'helper');
    time = 18000;health.record($,'claim',{kind:'ok'});expect(health.current()).toEqual({kind:'ok'});
    time = 18001;health.record($,'claim',{kind:'ok'});
    expect(health.current()).toMatchObject({kind:'transient',code:'timeout',producer:'helper',text:TURN_FAILURE});
    for (time = 19000; time <= 139000; time += 1000) health.record($,'claim',{kind:'ok'});
    expect(lines).toEqual([{at:139000,text:TURN_FAILURE}]);
    hung({kind:'ok'});
    expect(health.current()).toEqual({kind:'ok'});
    await balanced();
  });
});
