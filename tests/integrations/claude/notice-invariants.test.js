import { describe, expect, it, vi } from 'vitest';
import { createRegister } from '../../../integrations/claude/plugin/hooks/register.js';
import { claimLoop } from '../../../integrations/claude/plugin/hooks/claims.js';
import { BACKGROUND_RETRY, ModError, backgroundOutcome, conversationHealth, envelope, plainFailure } from '../../../integrations/claude/plugin/hooks/contracts.js';
import { binding, deferred, descriptor, failure, host, prepared } from './fixtures.js';

const MINUTE = 60000, GRACE = 2 * MINUTE;
const PRODUCERS = ['announce','helper','auto','qualification','claim','reports'];
// Call cadence: the poll tick for claims and reports, the heartbeat for the rest.
const INTERVALS = Object.freeze({announce:30000,helper:30000,auto:30000,qualification:30000,claim:1000,reports:1000});
// One poll is a report call, then a claim call once the reports are saved.
const POLLED = ['claim','reports'];
// A helper call may run to its eight-second kill, plus a store-lock wait, and
// still not count as hung.
const MAX_LATENCY = 10000;
// "Prints by two minutes plus one interval, whatever the call latency": one
// interval is one call cycle, the cadence plus the slowest call (two in a poll).
const cycle = producer => INTERVALS[producer] + 2 * MAX_LATENCY;
const FOLDER_MESSAGE = 'The selected project folder is missing or inaccessible; restore access to the project folder or select it again before reconnecting';

function coded(code, details) {
  return Object.assign(new ModError('PRIVATE fixture diagnostic.'),{code,details});
}
const unreadable = (() => {try {envelope({exitCode:0,stdout:'{',stderr:''});} catch (error) {return error;}})();
const CONNECT = 'Ariadne could not finish connecting this conversation. PRIVATE diagnostic.';
// Examples taken from the README health section, labelled with what it calls
// them, each with the sentence the owner should read. They are spec examples,
// not copies of the code's code tables or selection rules.
const SPEC = {
  // "Transient failures share one retry sentence."
  retry:['host_unreachable','store_busy','timeout','io_error','process_rejected']
    .map(code => ({cause:coded(code),given:CONNECT,text:BACKGROUND_RETRY})),
  // "Generic held codes, such as an unreadable reply, wait like retries."
  generic:[
    {cause:unreadable,text:unreadable.plain},
    {cause:coded('queue_full'),text:plainFailure('queue_full')},
    {cause:coded('revision_conflict'),text:plainFailure('revision_conflict')},
    {cause:new ModError('PRIVATE unknown reply.'),text:plainFailure('protocol_error')},
  ],
  // "Owner-needed held advice (paused, closed, recovery, conflicting or
  // removed sessions, uncertain saves) speaks immediately."
  owner:[
    ...['owner_paused','session_closed','recovery_required'].map(reason => ({cause:coded('invalid_transition',{reason}),text:plainFailure('invalid_transition',{reason})})),
    {cause:coded('binding_conflict'),text:plainFailure('binding_conflict')},
    {cause:coded('not_found'),text:plainFailure('not_found')},
    {cause:coded('delivery_uncertain'),text:plainFailure('delivery_uncertain')},
  ],
  // "Missing or unusable helpers ... share one installation repair sentence."
  install:['ENOENT','EACCES'].map(code => ({cause:Object.assign(new Error('PRIVATE spawn diagnostic'),{code}),given:CONNECT,text:plainFailure('incompatible_adapter')})),
  // A removed session or replaced connection stops the loop with one notice.
  terminal:[
    {cause:coded('stale_generation'),text:'This session was removed from Ariadne (or connected elsewhere). Run /ariadne-connect to connect again.'},
    {cause:coded('not_found'),text:'Ariadne: the Ariadne session for this conversation no longer exists. Run /ariadne-connect to connect again.'},
  ],
};
const EXAMPLES = Object.fromEntries(Object.entries(SPEC).map(([label,list]) => [label,list.map(example => Object.freeze({...example,label}))]));
const LABELS = new Map(Object.values(EXAMPLES).flat().map(example => [example.text,example.label]));
// "terminal, installation failure, held state": the urgent order.
const URGENCY = Object.freeze({owner:1,install:2,terminal:3});
const urgent = example => Boolean(URGENCY[example.label]);
function outcome(example) {
  if (!example) return {kind:'ok'};
  return backgroundOutcome(example.cause,example.given ?? example.text,{terminal:example.label === 'terminal'});
}

function check(condition, message) {if (!condition) throw new Error(message);}
function random(seed) {
  let state = seed;
  return max => {
    state ^= state << 13;state ^= state >>> 17;state ^= state << 5;
    return (state >>> 0) % max;
  };
}
const pick = (rng, list) => list[rng(list.length)];
const anyExample = rng => pick(rng,pick(rng,Object.values(EXAMPLES)));

// "A call still open after ten seconds (the helper's eight-second limit plus
// two seconds) counts as a temporary timeout for its producer until it ends."
const HUNG = 10000;
const TIMEOUT = Object.freeze({label:'retry',text:BACKGROUND_RETRY});

// Drives conversationHealth with timed calls: each call opens, takes its
// latency and settles with its one outcome. After every step it checks plain
// statements from the README against what printed. It keeps only what the
// README lets an observer know: who called when, each producer's latest
// outcome, retirements and the lines printed. Its liveness is the README's,
// not the code's: a producer counts from its first outcome until it is
// retired or reset, and each call adds exactly one outcome.
function simulation() {
  let time = 0, order = 0, failedAt = [], shown = null, advisers = [], quietAt = null;
  const queue = [], lines = [], trace = [];
  const $ = {store:{get:async () => [],set:async () => {}},ui:{log:text => lines.push({at:time,text,label:LABELS.get(text)})}};
  const model = conversationHealth(() => time);
  // `ends` counts successes, retirements and resets: each ends advice.
  // `calls` and `outcomes` count what the generator opened and settled.
  const known = new Map(PRODUCERS.map(producer => [producer,{counted:false,latest:null,ends:0,open:new Set(),calls:0,outcomes:0}]));
  const forget = p => {p.latest = null;p.ends += 1;};
  const hung = producer => [...known.get(producer).open].filter(call => time - call.start > HUNG);
  const live = producer => known.get(producer).counted || hung(producer).length > 0;
  // A producer's current outcome: a hung call counts as a timeout.
  const current = producer => hung(producer).length ? TIMEOUT : known.get(producer).latest;
  // A retired or reset producer's hung calls stop counting then.
  const close = p => {for (const call of p.open) if (time - call.start > HUNG) failedAt.push(call.start + HUNG);p.open.clear();};
  const at = (when, step) => queue.push({at:when,order:order++,...step});
  function apply(step) {
    const p = step.producer && known.get(step.producer);
    trace.push({at:time,op:step.op,producer:step.producer,text:step.example?.text});
    if (step.op === 'open') {
      p.calls += 1;
      p.open.add(step.call);
      step.call.settle = model.call($,step.producer);
    } else if (step.op === 'settle') {
      p.outcomes += 1;
      const value = outcome(step.example);
      if (step.example) check(value.text === step.example.text,`I4: background sentence was ${value.text}`);
      step.call.settle(value);
      // A call that outlived its producer's retirement records nothing.
      step.dead = !p.open.delete(step.call);
      if (step.dead) return;
      if (time - step.call.start > HUNG) failedAt.push(step.call.start + HUNG);
      p.counted = true;
      if (step.example) {p.latest = step.example;failedAt.push(time);}
      else forget(p);
    } else if (step.op === 'retire') {
      model.retire($,step.producer);
      close(p);
      p.counted = false;
      forget(p);
    } else if (step.op === 'reset') {
      model.reset();
      for (const each of known.values()) {close(each);each.counted = false;forget(each);}
      failedAt = [];shown = null;advisers = [];quietAt = null;
    } else if (step.op === 'owner') model.record({...$,background:false},step.producer,outcome(step.example));
  }
  function verify(step, emitted) {
    check(emitted.length <= 1,'One step printed more than one line');
    if (step.op === 'owner') check(!emitted.length,'An owner command printed a background notice');
    for (const line of emitted) {
      check(line.label && !/PRIVATE|could not finish connecting/.test(line.text),`I4: unknown or private line: ${line.text}`);
      if (line.label === 'retry' || line.label === 'generic') {
        const failures = [...failedAt,...PRODUCERS.flatMap(producer => hung(producer).map(call => call.start + HUNG))];
        check(failures.some(failed => failed <= time - GRACE),'I1: a retry or generic line printed before two minutes of failure');
        check(quietAt === null || time - quietAt >= GRACE,'I6: retry or generic lines less than two minutes apart');
        quietAt = time;
      }
      if (line.label === 'retry') {
        // "A retry line never replaces held, installation or terminal advice
        // until the producer that printed it recovers or is retired."
        for (const {producer,ends} of advisers) {
          check(!(live(producer) && known.get(producer).ends === ends),`I8: retry replaced advice from ${producer}, which neither recovered nor retired`);
        }
      } else if (step.op === 'settle' && step.example?.text === line.text) advisers = [{producer:step.producer,ends:known.get(step.producer).ends}];
      else {
        const holders = PRODUCERS.filter(producer => live(producer) && current(producer)?.text === line.text);
        advisers = holders.length === 1 ? holders.map(producer => ({producer,ends:known.get(producer).ends})) : [];
      }
      shown = line;
    }
    // "Owner-needed advice always shows within one call unless terminal or
    // install advice that is still current is showing", and likewise install
    // unless current terminal advice is showing. The line showing must be some
    // live producer's current outcome, and nothing live may be more urgent.
    if (step.op === 'settle' && !step.dead && step.example && urgent(step.example)) {
      check(shown !== null,`I5: ${step.example.label} advice never showed`);
      const outcomes = PRODUCERS.filter(live).map(current).filter(Boolean);
      const showing = URGENCY[shown.label] ?? 0, top = Math.max(0,...outcomes.map(each => URGENCY[each.label] ?? 0));
      check(showing >= URGENCY[step.example.label],`I5: ${step.example.label} advice from ${step.producer} did not show within one call; showing: ${shown.text}`);
      check(outcomes.some(each => each.text === shown.text),`I5: the line showing is no live producer's current outcome: ${shown.text}`);
      check(showing >= top,`I5: a more urgent current outcome is hidden behind ${shown.text}`);
    }
  }
  const sim = {
    lines,trace,model,
    get time() {return time;},
    get failedAt() {return failedAt;},
    // One call: it opens at `start` and settles `latency` later with its one outcome.
    call(producer, start, latency, example) {
      const call = {start,settle:null};
      at(start,{op:'open',producer,call});
      at(start + latency,{op:'settle',producer,call,example});
      return start + latency;
    },
    retire(when, producer) {at(when,{op:'retire',producer});},
    reset(when) {at(when,{op:'reset'});},
    owner(when, producer, example) {at(when,{op:'owner',producer,example});},
    run(until = Infinity) {
      queue.sort((left,right) => left.at - right.at || left.order - right.order);
      while (queue.length && queue[0].at <= until) {
        const step = queue.shift();
        check(step.at >= time,'Generated time moved backwards');
        time = step.at;
        const before = lines.length;
        apply(step);
        verify(step,lines.slice(before));
      }
      // "Each call adds exactly one outcome": counted from the outside.
      if (!queue.length) for (const [producer,p] of known) check(p.calls === p.outcomes,`${producer} opened ${p.calls} calls but settled ${p.outcomes}`);
    },
  };
  return sim;
}
// Schedules each producer's calls. A plan entry returns, for a call starting
// at a time, a failure example, null for success, or undefined for no call.
// Latencies are 0-10 s; a poll saves reports and then claims, so a claim call
// opens when its report call settles and takes 2-8 s, and a failed save holds
// the claim back. Every call settles with exactly one outcome.
function drive(sim, rng, plan, from, until) {
  for (const producer of Object.keys(plan).filter(name => !POLLED.includes(name))) {
    for (let start = from; start <= until;) {
      const example = plan[producer](start);
      if (example === undefined) {start += INTERVALS[producer];continue;}
      start = sim.call(producer,start,rng(MAX_LATENCY + 1),example) + INTERVALS[producer];
    }
  }
  if (!POLLED.some(producer => plan[producer])) return;
  for (let start = from; start <= until;) {
    // An empty report flush is a successful call.
    const report = plan.reports ? plan.reports(start) : null, claim = plan.claim?.(start);
    if (report === undefined && claim === undefined) {start += INTERVALS.claim;continue;}
    let end = start;
    if (report !== undefined) end = sim.call('reports',end,rng(8001),report);
    if (claim !== undefined && !report) end = sim.call('claim',end,2000 + rng(6001),claim);
    start = end + INTERVALS.claim;
  }
}
const SEEDS = 128;
function generated(name, exercise) {
  it(name,() => {
    let failures = 0, first;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const sim = simulation(), rng = random(seed);
      try {exercise(sim,rng);}
      catch (error) {failures += 1;first ??= {seed,message:error.message,lines:sim.lines,trace:sim.trace.slice(-40)};}
    }
    expect(failures,`${failures}/${SEEDS} failed seeded sequences; first failure:\n${JSON.stringify(first)}`).toBe(0);
  // The seeds take a few seconds alone and longer under the full suite's load.
  },60000);
}
// The README's "most recent failed call wins" leaves pollmates out: a failed
// report save holds the claim back, so its claim never runs.
const partners = producer => PRODUCERS.filter(other => other !== producer && !(POLLED.includes(producer) && POLLED.includes(other)));

describe('conversation-health regressions',() => {
  it('an idle report producer cannot suppress a later outage after three successful flushes',() => {
    let time = 0;
    const lines = [], $ = {store:{get:async () => [],set:async () => {}},ui:{log:text => lines.push({at:time,text})}};
    const model = conversationHealth(() => time);
    for (time = 0; time <= 120000; time += 1000) model.record($,'reports',outcome(EXAMPLES.retry[1]));
    expect(lines.map(line => line.text)).toEqual([BACKGROUND_RETRY]);
    for (time = 121000; time <= 123000; time += 1000) model.record($,'reports',{kind:'ok'});
    // The report queue drains and stays healthy. A later outage belongs to a
    // fresh continuous unhealthy interval, with its own grace and visible line.
    for (time = 9000000; time <= 9120000; time += 30000) model.record($,'announce',outcome(EXAMPLES.retry[0]));
    expect(lines).toEqual([{at:120000,text:BACKGROUND_RETRY},{at:9120000,text:BACKGROUND_RETRY}]);
  });
  it('every urgent held meaning is visible during one-second A/B flaps',() => {
    let time = 0;
    const lines = [], $ = {store:{get:async () => [],set:async () => {}},ui:{log:text => lines.push({at:time,text})}};
    const model = conversationHealth(() => time);
    for (time = 0; time <= 10000; time += 1000) {
      const example = EXAMPLES.owner[time % 2000 ? 1 : 0];
      model.record($,'helper',outcome(example));
      expect(lines.at(-1)).toEqual({at:time,text:example.text});
    }
  });
  it('owner-needed claim advice replaces generic announce advice at once',() => {
    let time = 0;
    const lines = [], $ = {store:{get:async () => [],set:async () => {}},ui:{log:text => lines.push({at:time,text})}};
    const model = conversationHealth(() => time);
    const generic = EXAMPLES.generic[1], paused = EXAMPLES.owner[0];
    for (time = 0; time <= 150000; time += 30000) model.record($,'announce',outcome(generic));
    expect(lines).toEqual([{at:120000,text:generic.text}]);
    for (time = 151000; time <= 160000; time += 1000) {
      model.record($,'announce',outcome(generic));
      model.record($,'claim',outcome(paused));
    }
    expect(lines).toEqual([{at:120000,text:generic.text},{at:151000,text:paused.text}]);
  });
});

describe('slow helper calls',() => {
  // The real claim loop over a helper whose every call takes `latency` ms.
  async function slow(latency, reply, {claim = null, slowed = 'claim'} = {}) {
    let time = 0;
    const lines = [];
    const h = host({claim,handler:async argv => {
      if (argv[2] !== slowed) return undefined;
      time += latency;
      return reply();
    }});
    const log = h.$.ui.log;
    h.$.ui.log = text => {lines.push({at:time,text});log(text);};
    const loop = claimLoop(descriptor.helperPath,binding,{now:() => time,health:conversationHealth(() => time)});
    while (time < 4 * MINUTE) {time += 1000;await loop.poll(h.$);await new Promise(resolve => setTimeout(resolve,0));}
    await loop.stop({...h.$,background:false});
    return lines;
  }
  // The helper's own five-second control timeout, the eight-second kill and a
  // store-lock wait each push results more than three ticks apart.
  it.each([2500,5000,8000])('a claim timeout that persists prints once by two minutes plus one call when each call takes %i ms',async latency => {
    const lines = await slow(latency,() => ({exitCode:null,stdout:'',stderr:''}));
    expect(lines.map(line => line.text)).toEqual([BACKGROUND_RETRY]);
    expect(lines[0].at).toBeLessThanOrEqual(1000 + latency + GRACE + 1000 + latency);
  });
  it.each([2500,5000,8000])('a paused claim prints once, not on every call, when each call takes %i ms',async latency => {
    const lines = await slow(latency,() => failure('invalid_transition',{reason:'owner_paused'}));
    expect(lines).toEqual([{at:1000 + latency,text:EXAMPLES.owner[0].text}]);
  });
  it.each([5000,8000])('a report save that keeps failing prints once by two minutes plus one call when each save takes %i ms',async latency => {
    const lines = await slow(latency,() => failure('store_busy'),{claim:await prepared(),slowed:'report'});
    expect(lines.map(line => line.text)).toEqual([BACKGROUND_RETRY]);
    expect(lines[0].at).toBeLessThanOrEqual(GRACE + 3 * (1000 + latency));
  });
  it('a project folder failure keeps its folder words in the background line',async () => {
    const lines = await slow(1000,() => ({exitCode:4,stdout:JSON.stringify({api_version:1,ok:false,error:{code:'host_unreachable',
      message:FOLDER_MESSAGE,hint:'Restore access.',retryable:true,field_errors:[]}}),stderr:''}));
    expect(lines.map(line => line.text)).toEqual(['The project folder is missing or inaccessible. Restore access or select it again; Ariadne will keep trying.']);
  });
});

describe('README health statements over 128 seeded histories with 0-10 s calls',() => {
  generated('a failure that persists prints once, on time, whatever the call latency',(sim,rng) => {
    const producer = pick(rng,PRODUCERS), example = anyExample(rng);
    drive(sim,rng,{[producer]:() => example},0,10 * MINUTE);
    sim.run();
    const first = sim.failedAt[0];
    check(sim.lines.length === 1 && sim.lines[0].text === example.text,`${producer} ${example.label}: printed ${sim.lines.length} lines`);
    const due = urgent(example) ? first : first + GRACE + cycle(producer);
    check(sim.lines[0].at <= due,`I1/I5: ${producer} ${example.label} printed at ${sim.lines[0].at}, due by ${due}`);
  });
  generated('owner-needed advice shows at once while generic advice from another producer is showing',(sim,rng) => {
    const generic = pick(rng,EXAMPLES.generic), owner = pick(rng,EXAMPLES.owner);
    const first = pick(rng,PRODUCERS), second = pick(rng,partners(first));
    // The generic line shows by about three minutes; owner-needed advice follows.
    const plan = {[first]:() => generic,[second]:start => start >= 4 * MINUTE ? owner : undefined};
    drive(sim,rng,plan,0,7 * MINUTE);
    sim.run(7 * MINUTE);
    check(sim.lines.map(line => line.text).join('|') === `${generic.text}|${owner.text}`,`${first} generic then ${second} owner printed: ${sim.lines.map(line => line.label)}`);
    const shown = sim.trace.find(step => step.op === 'settle' && step.producer === second);
    check(sim.lines[1].at === shown.at,'I5: owner-needed advice waited behind generic advice');
  });
  generated('generic advice never hides owner-needed advice that arrives first',(sim,rng) => {
    const generic = pick(rng,EXAMPLES.generic), owner = pick(rng,EXAMPLES.owner);
    const first = pick(rng,PRODUCERS), second = pick(rng,partners(first));
    drive(sim,rng,{[first]:() => owner,[second]:() => generic},0,6 * MINUTE);
    sim.run(6 * MINUTE);
    check(sim.lines.length === 1 && sim.lines[0].text === owner.text,`generic advice replaced owner-needed advice: ${sim.lines.map(line => line.label)}`);
  });
  generated('mixed slow producers keep every statement at every step and settle on the live cause',(sim,rng) => {
    const plan = {};
    for (const producer of PRODUCERS) {
      let example = null, until = 0;
      // Phases: idle, healthy, or one failure that repeats for a while.
      plan[producer] = start => {
        if (start >= until) {
          const roll = rng(10);
          example = roll < 2 ? undefined : roll < 4 ? null : anyExample(rng);
          until = start + pick(rng,[5000,30000,GRACE,5 * MINUTE]);
        }
        return example;
      };
    }
    drive(sim,rng,plan,0,15 * MINUTE);
    for (let i = 0; i < 8; i += 1) {
      const when = rng(15 * MINUTE), op = rng(8);
      if (op === 0) sim.reset(when);
      else if (op < 4) sim.retire(when,pick(rng,PRODUCERS));
      else sim.owner(when,pick(rng,PRODUCERS),anyExample(rng));
    }
    // Every loop stops and its producer retires; then one live cause settles.
    for (const each of PRODUCERS) sim.retire(17 * MINUTE,each);
    const producer = pick(rng,PRODUCERS), example = anyExample(rng);
    drive(sim,rng,{[producer]:() => example},18 * MINUTE,24 * MINUTE);
    sim.run();
    check(sim.lines.at(-1)?.text === example.text,`I5: the live ${example.label} cause from ${producer} did not replace stale advice`);
  });
  generated('one or two successes keep an outage; three successes or retiring end it',(sim,rng) => {
    const producer = pick(rng,PRODUCERS), example = pick(rng,EXAMPLES.retry), ends = rng(2);
    let goods = 0, recovered = 0;
    const plan = {[producer]:start => {
      if (start < 4 * MINUTE) {
        // Never three successes in a row inside the first outage.
        goods = goods < 2 && rng(4) === 0 ? goods + 1 : 0;
        return goods ? null : example;
      }
      if (start < 10 * MINUTE) return ends && recovered++ < 3 ? null : undefined;
      return start < 14 * MINUTE ? example : undefined;
    }};
    drive(sim,rng,plan,0,14 * MINUTE);
    // A producer that stops calling without recovering is retired once its last
    // call ends: its loop stopped.
    if (!ends) sim.retire(4 * MINUTE + 2 * MAX_LATENCY,producer);
    sim.run();
    const second = sim.failedAt.find(at => at >= 10 * MINUTE);
    check(sim.lines.length === 2,`I1/I2: two outages printed ${sim.lines.length} lines`);
    check(sim.lines[1].at >= second + GRACE && sim.lines[1].at <= second + GRACE + cycle(producer),'I1: the second outage did not wait its own two minutes');
  });
  generated('a retry never replaces held or install advice until its producer recovers or retires',(sim,rng) => {
    const producer = pick(rng,PRODUCERS), other = pick(rng,partners(producer));
    const advice = pick(rng,[...EXAMPLES.owner,...EXAMPLES.install]), recovers = rng(2);
    let goods = 0;
    drive(sim,rng,{[producer]:start => {
      if (start === 0) return advice;
      if (start < 10 * MINUTE) return rng(2) ? advice : pick(rng,EXAMPLES.retry);
      return recovers && goods++ < 3 ? null : undefined;
    }},0,16 * MINUTE);
    if (!recovers) sim.retire(10 * MINUTE + 2 * MAX_LATENCY,producer);
    sim.run(10 * MINUTE);
    check(sim.lines.length === 1 && sim.lines[0].text === advice.text,'I8: retry alternated with held or install advice from the same producer');
    drive(sim,rng,{[other]:() => pick(rng,EXAMPLES.retry)},11 * MINUTE,16 * MINUTE);
    sim.run();
    check(sim.lines.at(-1).text === BACKGROUND_RETRY,'I8: retry stayed hidden after the advising producer recovered or retired');
  });
  generated('long runs of empty calls on one producer never hide owner-needed advice from another',(sim,rng) => {
    const first = pick(rng,PRODUCERS), second = pick(rng,partners(first));
    const stale = anyExample(rng), owner = pick(rng,EXAMPLES.owner), arrives = MINUTE + rng(8 * MINUTE);
    // One failure, then only calls with nothing to report, each recording ok.
    drive(sim,rng,{[first]:start => start === 0 ? stale : null,[second]:start => start >= arrives ? owner : undefined},0,10 * MINUTE);
    sim.run();
    const shown = sim.trace.find(step => step.op === 'settle' && step.producer === second);
    check(sim.lines.some(line => line.at === shown.at && line.text === owner.text),`I5: ${second} owner-needed advice waited behind ${first}'s stale ${stale.label} outcome`);
  });
  generated('a hung call counts as a timeout until it settles, and nothing longer',(sim,rng) => {
    const producer = pick(rng,PRODUCERS), other = pick(rng,partners(producer));
    const hang = HUNG + 1 + rng(5 * MINUTE), settles = pick(rng,[null,pick(rng,EXAMPLES.retry)]);
    // The other producer keeps calling with nothing to report, so health is
    // evaluated throughout.
    drive(sim,rng,{[other]:() => null},0,8 * MINUTE);
    sim.call(producer,0,hang,settles);
    sim.run();
    // A hang is seen at the first check after ten seconds, and prints at the
    // first check after the grace: each comes with the other producer's calls.
    const retries = sim.lines.filter(line => line.text === BACKGROUND_RETRY), due = HUNG + GRACE + 2 * cycle(other);
    check(sim.lines.length === retries.length && retries.length <= 1,`a hung call printed ${sim.lines.map(line => line.label)}`);
    if (hang >= due) check(retries[0]?.at <= due,`a call hung for ${hang} ms printed its retry line at ${retries[0]?.at}, due by ${due}`);
    if (hang < HUNG + GRACE && settles === null) check(!retries.length,`a call hung for ${hang} ms then healthy printed a retry line`);
  });
  generated('two equally urgent producers keep the line already showing until it recovers',(sim,rng) => {
    const first = pick(rng,PRODUCERS), second = pick(rng,partners(first));
    const a = pick(rng,EXAMPLES.owner), b = pick(rng,EXAMPLES.owner.filter(example => example.text !== a.text));
    let recovering = null;
    const plan = {[first]:start => start < 10 * MINUTE || recovering !== first ? a : null,
      [second]:start => start < 10 * MINUTE || recovering !== second ? b : null};
    drive(sim,rng,plan,0,10 * MINUTE);
    sim.run(10 * MINUTE);
    check(sim.lines.length === 1,`I7: two equally urgent producers flipped the shown line ${sim.lines.length} times`);
    recovering = sim.lines[0].text === a.text ? first : second;
    drive(sim,rng,plan,10 * MINUTE + 2 * MAX_LATENCY,12 * MINUTE);
    sim.run();
    check(sim.lines.length === 2 && sim.lines[1].text === (recovering === first ? b : a).text,'I5/I7: the other advice did not show once the shown producer recovered');
  });
  generated('urgent advice that clears never restarts the outage clock or retry spacing',(sim,rng) => {
    const producer = pick(rng,PRODUCERS.filter(name => !POLLED.includes(name)));
    drive(sim,rng,{[producer]:() => pick(rng,EXAMPLES.retry)},0,10 * MINUTE);
    drive(sim,rng,{claim:start => Math.floor(start / 30000) % 2 ? pick(rng,EXAMPLES.owner) : null},30000,10 * MINUTE);
    sim.run();
    const retries = sim.lines.filter(line => line.text === BACKGROUND_RETRY);
    check(retries[0]?.at <= sim.failedAt[0] + GRACE + cycle(producer),'I1/I5: clearing urgent advice reset the outage clock');
    check(retries.length >= 3,`I5: the retry line returned only ${retries.length} times after urgent advice cleared`);
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
const HELD = ['owner_paused','session_closed','recovery_required','unrecognized'];

describe('real background producers use the conversation-health outcome boundary',() => {
  it('claim and report held notices are current immediately and never use connect-failure text',async () => {
    let time = 0, reason = 'owner_paused', mode = 'claim';
    const value = await prepared(), submission = deferred();
    const h = host({claim:value,submit:() => submission.promise,handler:argv => {
      if (mode === 'claim' && argv[2] === 'claim') return failure('invalid_transition',{reason});
      if (mode === 'report' && argv[2] === 'report') return failure('invalid_transition',{reason});
    }});
    const model = conversationHealth(() => time);
    const loop = claimLoop(descriptor.helperPath,binding,{health:model,now:() => time});
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
    const model = conversationHealth(() => time);
    const loop = claimLoop(descriptor.helperPath,binding,{health:model,now:() => time});
    await loop.poll(h.$);
    await vi.waitFor(() => expect(h.calls.filter(call => call.argv[2] === 'report')).toHaveLength(1));
    expect(h.logs.at(-1)).toMatch(/paused/);
    refuse = false;time = 1000;await loop.poll(h.$);
    expect(h.events.map(event => event.kind)).toEqual(['accepted']);
    expect(model.current()).toEqual({kind:'ok'});
    // No more report events exist. Empty flushes must remain successful evidence.
    time = 2000;await loop.poll(h.$);
    time = 9000000;model.record(h.$,'announce',outcome(EXAMPLES.retry[0]));
    for (time = 9030000; time <= 9120000; time += 30000) model.record(h.$,'announce',outcome(EXAMPLES.retry[0]));
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
