import { describe, expect, it, vi } from 'vitest';
import { createRegister } from '../../../integrations/claude/plugin/hooks/register.js';
import { claimLoop } from '../../../integrations/claude/plugin/hooks/claims.js';
import { binding, deferred, descriptor, failure, host, prepared } from './fixtures.js';
import * as liveContracts from '../../../integrations/claude/plugin/hooks/contracts.js';

const contracts = process.env.ARIADNE_NOTICE_BASELINE
  ? await import(/* @vite-ignore */ process.env.ARIADNE_NOTICE_BASELINE) : liveContracts;
const { BACKGROUND_RETRY, ModError, plainFailure } = contracts;
const MINUTE = 60000;
const PRODUCERS = ['announce','helper','auto','qualification','claim','reports'];
const INTERVALS = Object.fromEntries(PRODUCERS.map(producer => [producer,['claim','reports'].includes(producer) ? 1000 : 30000]));
const TRANSIENTS = ['host_unreachable','store_busy','timeout','io_error','process_rejected'];
const HELD = ['owner_paused','session_closed','recovery_required','unrecognized'];
// Generic held codes: not owner-needed, so they wait out the grace like retries.
const GENERIC_HELD = ['protocol_error','revision_conflict','queue_full'];
const TERMINALS = ['stale_generation','binding_mismatch','not_found','delivery_uncertain','commit_uncertain'];
const INSTALL = plainFailure('incompatible_adapter');
function error(code, details) {
  return Object.assign(new ModError('Fixture diagnostic.'),{code,details});
}
function outcome(kind, code, reason) {
  const text = kind === 'transient' ? BACKGROUND_RETRY : kind === 'install' ? INSTALL : plainFailure(code,reason ? {reason} : undefined);
  return {kind,code,text,reason};
}
// Baseline-only bridge preserves the old implementation's real fail/good logic.
// Production always exercises conversationHealth directly once it is exported.
function health(now, intervals = INTERVALS) {
  if (contracts.conversationHealth) return contracts.conversationHealth(now,intervals);
  const old = contracts.noticeEpisodes(now);
  return {
    record($,producer,value) {
      if (value.kind === 'ok') return old.good($,producer);
      const code = value.kind === 'install' ? 'incompatible_adapter' : value.code;
      return old.fail($,producer,error(code,value.reason ? {reason:value.reason} : undefined),value.text,BACKGROUND_RETRY,{terminal:value.kind === 'terminal'});
    },
    delete($,producer) {old.delete(producer);},
    reset() {old.reset();},
  };
}
function fixture() {
  let time = 0;
  const lines = [];
  const $ = {store:{get:async () => [],set:async () => {}},ui:{log:text => lines.push({at:time,text})}};
  const model = health(() => time);
  return {$,lines,model,call(at,producer,value) {time = at;model.record($,producer,value);}};
}

describe('conversation-health generated regressions',() => {
  it('blocker 1: an idle report producer cannot suppress a later outage after one successful flush',() => {
    const h = fixture();
    for (let at = 0; at <= 120000; at += 1000) h.call(at,'reports',outcome('transient','store_busy'));
    expect(h.lines.map(line => line.text)).toEqual([BACKGROUND_RETRY]);
    h.call(121000,'reports',{kind:'ok'});
    // The report queue drains and never calls again. A later outage belongs to
    // a fresh continuous unhealthy interval, with its own grace and visible line.
    for (let at = 9000000; at <= 9120000; at += 30000) h.call(at,'announce',outcome('transient','host_unreachable'));
    expect(h.lines.map(line => line.text)).toEqual([BACKGROUND_RETRY,BACKGROUND_RETRY]);
    expect(h.lines.at(-1).at).toBe(9120000);
  });
  it('I5 finding 3: every current urgent held meaning is visible during one-second A/B flaps',() => {
    const h = fixture();
    for (let at = 0; at <= 10000; at += 1000) {
      const reason = at % 2000 ? 'session_closed' : 'owner_paused';
      const value = outcome('held','invalid_transition',reason);
      h.call(at,'helper',value);
      expect(h.lines.at(-1)).toEqual({at,text:value.text});
    }
  });
});


const SEEDS = 256;
function random(seed) {
  let state = seed;
  return max => {
    state ^= state << 13;state ^= state >>> 17;state ^= state << 5;
    return (state >>> 0) % max;
  };
}
function check(condition, message) {if (!condition) throw new Error(message);}
const priority = {transient:1,held:2,install:3,terminal:4};
// Held advice the owner must act on speaks at once; generic held codes wait.
const OWNER_NEEDED = ['invalid_transition','binding_conflict','stale_generation','binding_mismatch','binding_ambiguous',
  'not_found','permission_denied','unsupported','unsupported_host_version','delivery_uncertain','commit_uncertain','protocol_conflict'];
const urgent = value => Boolean(value) && (value.kind === 'terminal' || value.kind === 'install' || (value.kind === 'held' && OWNER_NEEDED.includes(value.code)));
function visible(value) {return value && {kind:value.kind,code:value.code,text:value.text,producer:value.producer};}

// Oracle reconstructs each producer's evidence from its input history. It has no
// implementation slots, forks, episode counters, debounce or implementation keys.
// Beyond the history it remembers only what was printed: the last line, its
// producer and kind, the continuous bad clock and non-urgent spacing.
function oracle(intervals) {
  // Per-producer input history. A delete retires everything before it, so each
  // list keeps only events since that producer's last delete.
  let history = new Map(), badSince = null, lastText = null, nonurgentAt = null, shown = null;
  function selected(at) {
    const candidates = failing(at);
    // I7: the line showing stays while its producer still fails at the top priority.
    return candidates.find(candidate => candidate.producer === shown?.producer && priority[candidate.kind] === priority[candidates[0]?.kind])
      ?? candidates[0] ?? null;
  }
  function failing(at) {
    const candidates = [];
    for (const producer of PRODUCERS) {
      const events = history.get(producer) ?? [];
      const last = events.at(-1);
      if (!last || last.op === 'delete' || at - last.at > intervals[producer] * 3) continue;
      const failed = events.findLastIndex(event => event.op === 'record' && event.value.kind !== 'ok');
      if (failed < 0) continue;
      const evidence = events[failed];
      const successes = events.length - failed - 1;
      if (successes >= (evidence.value.kind === 'transient' ? 3 : 1)) continue;
      // A previous producer lifetime cannot revive after an idle gap.
      let idle = false;
      for (let index = failed + 1; index < events.length && !idle; index += 1) idle = events[index].at - events[index - 1].at > intervals[producer] * 3;
      if (idle) continue;
      candidates.push({...evidence.value,producer,at:evidence.at});
    }
    candidates.sort((left,right) => priority[right.kind] - priority[left.kind] || right.at - left.at || PRODUCERS.indexOf(left.producer) - PRODUCERS.indexOf(right.producer));
    return candidates;
  }
  return {
    step(event) {
      if (!selected(event.at)) {badSince = null;lastText = null;shown = null;}
      if (event.op === 'reset') {history = new Map();badSince = null;lastText = null;nonurgentAt = null;shown = null;}
      else if (event.op === 'delete') history.set(event.producer,[event]);
      else if (event.op !== 'owner') {
        if (!history.has(event.producer)) history.set(event.producer,[]);
        history.get(event.producer).push(event);
      }
      const current = selected(event.at);
      if (!current) {badSince = null;lastText = null;shown = null;return {current:null,line:null};}
      badSince ??= event.at;
      if (current.text === lastText) return {current,line:null};
      const due = urgent(current) || (event.at - badSince >= 120000 && (nonurgentAt === null || event.at - nonurgentAt >= 120000));
      // I8: retry never replaces held, install or terminal advice whose producer
      // has neither recovered nor expired.
      const anchored = current.kind === 'transient' && shown !== null && shown.kind !== 'transient'
        && failing(event.at).some(candidate => candidate.producer === shown.producer);
      // Owner commands are observational: they neither consume spacing nor emit.
      if (!due || anchored || event.op === 'owner') return {current,line:null};
      lastText = current.text;
      shown = {producer:current.producer,kind:current.kind};
      if (!urgent(current)) nonurgentAt = event.at;
      return {current,line:{at:event.at,text:current.text,urgent:urgent(current)}};
    },
  };
}
function generatedHarness(seed, intervals = INTERVALS) {
  let time = 0, lastNonurgent = null;
  const trace = [], actual = [], wanted = [];
  const $ = {store:{get:async () => [],set:async () => {}},ui:{log:text => actual.push({at:time,text})}};
  const model = health(() => time,intervals), expected = oracle(intervals);
  return {
    trace,actual,wanted,
    call(event) {
      check(event.at >= time,'Generated time moved backwards');
      time = event.at;trace.push(event);
      const before = actual.length;
      const result = expected.step(event);
      if (result.line) wanted.push(result.line);
      if (event.op === 'reset') {model.reset();lastNonurgent = null;}
      else if (event.op === 'delete') model.delete($,event.producer);
      else if (event.op === 'owner') model.record({...$,background:false},event.producer,event.value);
      else {
        let value = event.value;
        if (value.kind !== 'ok' && contracts.backgroundOutcome) {
          const cause = value.kind === 'install' ? Object.assign(new Error('private fixture diagnostics'),{code:seed % 2 ? 'ENOENT' : 'EACCES'})
            : error(value.code,value.reason ? {reason:value.reason} : undefined);
          value = contracts.backgroundOutcome(cause,value.kind === 'transient' || value.kind === 'install' ? 'Ariadne could not finish connecting this conversation. PRIVATE diagnostic.' : value.text,{terminal:value.kind === 'terminal'});
          check(value.kind === event.value.kind && value.code === (event.value.kind === 'install' ? 'incompatible_adapter' : event.value.code) && value.text === event.value.text,'I4: background classification leaked command or diagnostic wording');
        }
        model.record($,event.producer,value);
      }
      if (model.current) {
        const current = model.current();
        check(JSON.stringify(current?.kind === 'ok' ? null : visible(current)) === JSON.stringify(visible(result.current)),`I5: current selected meaning differs: ${JSON.stringify(current)} expected ${JSON.stringify(visible(result.current))}`);
      }
      // Every family checks every observable invariant after every event.
      const emitted = actual.slice(before);
      check(emitted.length === (result.line ? 1 : 0),'I1/I2/I3/I5: missing, duplicated, delayed or stale current notice');
      if (result.line) check(emitted[0].at === result.line.at && emitted[0].text === result.line.text,'I5: emitted meaning was not current at its eligible deadline');
      check(actual.every(line => !/PRIVATE|Fixture diagnostic|could not finish connecting this conversation|host_unreachable|store_busy/.test(line.text)),'I4: background line exposed command or diagnostic text');
      if (result.line && !result.line.urgent) {
        check(lastNonurgent === null || time - lastNonurgent >= 120000,'I6: nonurgent lines exceeded the shared two-minute spacing');
        lastNonurgent = time;
      }
    },
  };
}
function generated(name, exercise) {
  it(name,() => {
    let failures = 0, first;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const h = generatedHarness(seed);
      try {exercise(h,random(seed));}
      catch (failure) {failures += 1;first ??= {seed,message:failure.message,trace:h.trace,actual:h.actual,wanted:h.wanted};}
    }
    expect(failures,`${failures}/${SEEDS} failed seeded sequences; replay seed and trace:\n${JSON.stringify(first)}`).toBe(0);
  // 256 seeds take a few seconds alone and longer under the full suite's load.
  },30000);
}
const record = (at,producer,value) => ({at,producer,value,op:'record'});
const ok = (at,producer) => record(at,producer,{kind:'ok'});
const bad = (at,producer,code = 'store_busy') => record(at,producer,outcome('transient',code));
const hold = (at,producer,reason) => record(at,producer,outcome('held','invalid_transition',reason));
function anyFailure(rng) {
  const kind = rng(9);
  if (kind < 4) return outcome('transient',TRANSIENTS[rng(TRANSIENTS.length)]);
  if (kind < 6) return outcome('held','invalid_transition',HELD[rng(HELD.length)]);
  if (kind === 6) return outcome('held',GENERIC_HELD[rng(GENERIC_HELD.length)]);
  if (kind === 7) return outcome('install','incompatible_adapter');
  return outcome('terminal',TERMINALS[rng(TERMINALS.length)]);
}

describe('I1–I8 independent observable oracle (2,560 seeded sequences)',() => {
  generated('all six producers alternate all transient codes at their real cadence', (h,rng) => {
    const producer = PRODUCERS[rng(PRODUCERS.length)], interval = INTERVALS[producer];
    for (let at = 0; at <= 10 * MINUTE; at += interval) h.call(bad(at,producer,TRANSIENTS[(at / interval) % TRANSIENTS.length]));
    check(h.actual.length === 1 && h.actual[0].at <= 120000 + interval,'I1: continuous transient outage missed its first eligible deadline');
  });
  generated('overlapping responsibility keeps one continuous bad clock', (h,rng) => {
    let previous = PRODUCERS[rng(4)];
    h.call(bad(0,previous));
    for (let at = 30000; at <= 600000; at += 30000) {
      const next = PRODUCERS[(PRODUCERS.indexOf(previous) + 1 + rng(3)) % 4];
      h.call(bad(at,next,TRANSIENTS[rng(5)]));
      for (let i = 1; i <= 3; i += 1) h.call(ok(at + i,previous));
      previous = next;
    }
    check(h.actual[0]?.at <= 150000,'I1: handoffs restarted continuous unhealthy grace');
  });
  generated('idle and dropped producers cannot suppress a subsequent outage', (h,rng) => {
    const producer = PRODUCERS[rng(PRODUCERS.length)], interval = INTERVALS[producer];
    for (let at = 0; at <= 120000; at += interval) h.call(bad(at,producer));
    h.call(ok(120001,producer));
    const start = 120001 + interval * 3 + 1;
    for (let at = start; at <= start + 120000; at += 1000) h.call(bad(at,'reports',TRANSIENTS[rng(5)]));
    check(h.actual.length === 2,'I1/I2: idle evidence prevented rearming the later unhealthy interval');
  });
  generated('transient one/two successes retain meaning; three successes rearm grace', (h,rng) => {
    const producer = PRODUCERS[rng(4)];
    for (let i = 0; i < 24; i += 1) {
      const at = i * 30000;
      h.call(bad(at,producer,TRANSIENTS[rng(5)]));
      for (let good = 0, count = rng(3); good < count; good += 1) h.call(ok(at + good,producer));
    }
    for (let i = 0; i < 3; i += 1) h.call(ok(720000 + i,producer));
    for (let at = 721000; at <= 841000; at += 30000) h.call(bad(at,producer));
    check(h.actual.length === 2,'I1/I2: recovery evidence did not separate transient unhealthy stretches');
  });
  generated('urgent held/install/terminal flaps immediately replace the current line', (h,rng) => {
    const producer = PRODUCERS[rng(PRODUCERS.length)];
    for (let at = 0; at <= 600000; at += rng(2) ? 1000 : 30000) {
      const kind = rng(3);
      const value = kind === 0 ? outcome('held','invalid_transition',HELD[rng(4)]) : kind === 1 ? outcome('install','incompatible_adapter') : outcome('terminal',TERMINALS[rng(5)]);
      h.call(record(at,producer,value));
      if (rng(3) === 0) h.call(ok(at,producer));
    }
    check(h.actual.length > 6,'Urgent flaps must exercise the standing exemption from I6');
  });
  generated('urgent enter/clear never restarts continuous transient time or nonurgent spacing', (h,rng) => {
    const producer = PRODUCERS[rng(4)];
    h.call(bad(0,producer));
    for (let at = 30000; at <= 600000; at += 30000) {
      h.call(bad(at,producer,TRANSIENTS[rng(5)]));
      h.call(hold(at,'claim',HELD[rng(4)]));
      h.call(ok(at + 1000,'claim'));
    }
    const retries = h.actual.filter(line => line.text === BACKGROUND_RETRY);
    check(retries[0]?.at <= 121000,'I1/I5: urgent flap reset the continuous unhealthy clock');
    check(retries.length >= 4,'I5: transient current meaning never returned after urgent recovery');
  });
  generated('delete and reset retire evidence; owner observations preserve background state', (h,rng) => {
    let at = 0;
    for (let i = 0; i < 160; i += 1) {
      at += rng(2) ? 1000 : 30000;
      const producer = PRODUCERS[rng(6)], op = rng(12);
      if (op === 0) h.call({at,op:'reset'});
      else if (op < 3) h.call({at,op:'delete',producer});
      else if (op < 5) h.call({at,op:'owner',producer,value:anyFailure(rng)});
      else h.call(record(at,producer,op < 7 ? {kind:'ok'} : anyFailure(rng)));
    }
    h.call({at:at + 1,op:'reset'});
    h.call(hold(at + 2,'helper','owner_paused'));
    check(h.actual.at(-1)?.at === at + 2,'I3/I5: reset kept stale suppression or urgency spacing');
  });
  generated('irregular mixed prefixes settle to the live meaning at every eligible deadline', (h,rng) => {
    let at = 0;
    for (let i = 0; i < 192; i += 1) {
      at += [1000,30000,90001,9000000][rng(4)];
      const producer = PRODUCERS[rng(6)];
      h.call(record(at,producer,rng(4) === 0 ? {kind:'ok'} : anyFailure(rng)));
    }
    // Let all previous producers drop out, then settle to a single current cause.
    at += 90001;
    const producer = PRODUCERS[rng(6)], value = anyFailure(rng), interval = INTERVALS[producer];
    for (let offset = 0; offset <= 240000; offset += interval) h.call(record(at + offset,producer,value));
    check(h.actual.at(-1)?.text === value.text,'I5: stable current meaning did not replace stale advice');
  });
  generated('equal-priority failing producers keep the line already showing until it recovers', (h,rng) => {
    const first = PRODUCERS[rng(PRODUCERS.length)], second = PRODUCERS.filter(producer => producer !== first)[rng(PRODUCERS.length - 1)];
    const a = HELD[rng(HELD.length)], b = HELD.filter(reason => reason !== a)[rng(HELD.length - 1)];
    const end = 600000;
    for (let at = 0; at <= end; at += 1000) {
      const due = [[first,a],[second,b]].filter(([producer]) => at % INTERVALS[producer] === 0);
      if (rng(2)) due.reverse();
      for (const [producer,reason] of due) h.call(hold(at,producer,reason));
    }
    check(h.actual.length === 1,'I7: two equally important producers flipped the shown line');
    // Either producer may have spoken first; recover that one.
    const firstShown = h.actual[0].text === outcome('held','invalid_transition',a).text;
    h.call(ok(end + 1,firstShown ? first : second));
    check(h.actual.length === 2 && h.actual[1].text === outcome('held','invalid_transition',firstShown ? b : a).text,'I5/I7: the other advice did not speak once the shown producer recovered');
  });
  generated('a retry line never replaces held or install advice until its producer recovers or expires', (h,rng) => {
    const producer = PRODUCERS[rng(PRODUCERS.length)], interval = INTERVALS[producer];
    const other = PRODUCERS.filter(name => name !== producer)[rng(PRODUCERS.length - 1)];
    const advice = rng(2) ? outcome('install','incompatible_adapter') : outcome('held','invalid_transition',HELD[rng(HELD.length)]);
    h.call(record(0,producer,advice));
    let at = interval;
    for (; at <= 600000; at += interval) h.call(record(at,producer,rng(2) ? advice : outcome('transient',TRANSIENTS[rng(TRANSIENTS.length)])));
    check(h.actual.length === 1 && h.actual[0].text === advice.text,'I8: retry alternated with held or install advice from the same producer');
    if (rng(2)) {
      // Recovery: three good calls clear even a transient last outcome.
      for (let good = 0; good < 3; good += 1, at += interval) h.call(ok(at,producer));
    }
    // Otherwise the producer goes idle and expires while another one fails.
    for (const stop = at + 240000 + INTERVALS[other] * 3; at <= stop; at += INTERVALS[other]) h.call(bad(at,other,TRANSIENTS[rng(TRANSIENTS.length)]));
    check(h.actual.at(-1)?.text === BACKGROUND_RETRY,'I8: retry stayed hidden after the advising producer recovered or expired');
  });
});


function callbacks() {
  const hooks = new Map();
  createRegister(descriptor,{waitMs:0,pollMs:0})((name,pattern,handler) => {
    if (typeof pattern === 'function') {handler = pattern;pattern = null;}
    hooks.set(pattern?.command ?? name,pattern?.command ? ($,event = {args:''}) => handler($,event) : handler);
  });
  return hooks;
}
const next = async event => event;
function injected(model, now) {
  return contracts.conversationHealth ? {health:model,now} : {notices:contracts.noticeEpisodes(now),now};
}

describe('real background producers use the conversation-health outcome boundary',() => {
  it('claim and report held notices are current immediately and never use connect-failure text',async () => {
    let time = 0, reason = 'owner_paused', mode = 'claim';
    const value = await prepared(), submission = deferred();
    const h = host({claim:value,submit:() => submission.promise,handler:argv => {
      if (mode === 'claim' && argv[2] === 'claim') return failure('invalid_transition',{reason});
      if (mode === 'report' && argv[2] === 'report') return failure('invalid_transition',{reason});
    }});
    const model = health(() => time);
    const loop = claimLoop(descriptor.helperPath,binding,injected(model,() => time));
    await loop.poll(h.$);
    expect(h.logs.at(-1)).toMatch(/paused/);
    time = 1000;reason = 'session_closed';await loop.poll(h.$);
    expect(h.logs.at(-1)).toMatch(/closed/);
    mode = 'allow';time = 2000;await loop.poll(h.$);
    mode = 'report';reason = 'recovery_required';
    await loop.start(h.$,{text:value.formatted_payload,turnId:'generated-notice-turn'});
    expect(h.logs.at(-1)).toMatch(/attention/);
    expect(h.logs.join(' ')).not.toMatch(/could not finish connecting|invalid_transition|recovery_required|Fixture failure/);
    mode = 'allow';await loop.poll(h.$);
    await loop.complete(h.$,{turnId:'generated-notice-turn',answer:'done',reason:'answer',isAborted:false});
    submission.resolve({text:value.formatted_payload});
    await loop.stop(h.$);
  });
  it('one failed report followed by one durable flush does not leave an idle held report producer',async () => {
    let time = 0, refuse = true;
    const value = await prepared();
    const h = host({claim:value,handler:argv => argv[2] === 'report' && refuse ? failure('invalid_transition',{reason:'owner_paused'}) : undefined});
    const model = health(() => time);
    const loop = claimLoop(descriptor.helperPath,binding,injected(model,() => time));
    await loop.poll(h.$);
    await vi.waitFor(() => expect(h.calls.filter(call => call.argv[2] === 'report')).toHaveLength(1));
    expect(h.logs.at(-1)).toMatch(/paused/);
    refuse = false;time = 1000;await loop.poll(h.$);
    expect(h.events.map(event => event.kind)).toEqual(['accepted']);
    if (model.current) expect(model.current()).toEqual({kind:'ok'});
    // No more report events exist. Empty flushes must remain successful evidence.
    time = 2000;await loop.poll(h.$);
    time = 9000000;model.record(h.$,'announce',outcome('transient','host_unreachable'));
    for (time = 9030000; time <= 9120000; time += 30000) model.record(h.$,'announce',outcome('transient','host_unreachable'));
    expect(h.logs.at(-1)).toBe(BACKGROUND_RETRY);
    await loop.stop(h.$);
  });
  it('heartbeat and turn callbacks keep raw SDK failures quiet until grace while owner commands retain direct answers',async () => {
    let time = 0, down = false;
    const clock = vi.spyOn(Date,'now').mockImplementation(() => time);
    try {
      const h = host({handler:argv => {
        if (down && argv[2] === 'announce') throw new Error('PRIVATE raw SDK diagnostic');
        if (down && argv[2] === 'connection-status') return failure('host_unreachable');
      }});
      const hooks = callbacks();
      await hooks.get('session.start')(h.$,{},next);
      await hooks.get('ariadne-connect')(h.$);
      const heartbeat = h.timers().find(timer => timer.ms === 30000), start = h.logs.length;
      down = true;
      for (time = 0; time <= 90000; time += 30000) {
        await heartbeat.callback();
        await hooks.get('turn.start')(h.$,{text:'ordinary owner text',turnId:`owner-${time}`},next);
        const answer = await hooks.get('ariadne-status')(h.$);
        expect(answer.text).toContain('That did not complete.');
        expect(h.logs.slice(start).filter(text => text === BACKGROUND_RETRY)).toEqual([]);
      }
      time = 120000;await heartbeat.callback();
      expect(h.logs.slice(start).filter(text => text === BACKGROUND_RETRY)).toEqual([BACKGROUND_RETRY]);
      expect(h.logs.slice(start).join(' ')).not.toMatch(/PRIVATE|could not finish connecting this conversation/);
      down = false;
      await hooks.get('session.end')(h.$,{},next);
    } finally {clock.mockRestore();}
  });
});


it('32 seeded real register histories keep held claim advice current across heartbeat, turn and owner calls',async () => {
  let time = 0;
  const clock = vi.spyOn(Date,'now').mockImplementation(() => time);
  try {
    for (let seed = 1; seed <= 32; seed += 1) {
      const rng = random(seed), trace = [];
      let reason = 'owner_paused';
      const h = host({handler:argv => argv[2] === 'claim' ? failure('invalid_transition',{reason}) : undefined});
      const hooks = callbacks();
      time = 0;
      await hooks.get('session.start')(h.$,{},next);
      await hooks.get('ariadne-connect')(h.$);
      const poll = h.timer(), heartbeat = h.timers().find(timer => timer.ms === 30000);
      for (let step = 0; step < 48; step += 1) {
        time += rng(2) ? 1000 : 30000;
        reason = HELD[rng(HELD.length)];trace.push({at:time,reason});
        await poll.callback();
        const expected = {owner_paused:/paused/,session_closed:/closed/,recovery_required:/attention/,unrecognized:/holding/}[reason];
        expect(h.logs.at(-1),`I5 real producer seed=${seed}; trace=${JSON.stringify(trace)}`).toMatch(expected);
        // Successful direct commands and unrelated turns must not erase the
        // claim producer's standing outcome or turn it into connect advice.
        await hooks.get('ariadne-status')(h.$);
        await hooks.get('turn.start')(h.$,{text:'ordinary text',turnId:`seed-${seed}-${step}`},next);
        if (rng(2)) await heartbeat.callback();
        expect(h.logs.join(' '),`I4 real producer seed=${seed}`).not.toMatch(/could not finish connecting this conversation|invalid_transition|Fixture failure/);
      }
      await hooks.get('session.end')(h.$,{},next);
    }
  } finally {clock.mockRestore();}
});
