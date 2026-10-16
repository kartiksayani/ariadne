import { describe, expect, it } from 'vitest';
import { envelope, ModError, noticeEpisodes, plainFailure } from '../../../integrations/claude/plugin/hooks/contracts.js';

// Generated observable contracts, deliberately independent of the implementation's
// episode bookkeeping. Every failed family reports a reproducible seed and trace.
const SEEDS = 256;
const MINUTE = 60000;
const SLOTS = ['announce','helper','claim','auto','reports'];
const TRANSIENTS = ['host_unreachable','store_busy','timeout','io_error','process_rejected'];
const HELD = ['owner_paused','session_closed','recovery_required','unrecognized'];
const TERMINALS = ['stale_generation','binding_mismatch','not_found','delivery_uncertain','commit_uncertain'];
const RETRY = 'Fixture retry notice.';
const INSTALL = "Ariadne and its Claude plugin don't match, so this was not recorded. Update both to the same version.";
const heldText = reason => `Fixture held notice: ${reason}.`;
const terminalText = code => `Fixture terminal notice: ${code}.`;

function random(seed) {
  let state = seed;
  return max => {
    state ^= state << 13;state ^= state >>> 17;state ^= state << 5;
    return (state >>> 0) % max;
  };
}
function error(code, details) {
  const value = new ModError('Fixture diagnostic.');
  value.code = code;
  if (details) value.details = details;
  return value;
}
function meaning(text) {
  if (text === RETRY) return 'retry';
  if (text === INSTALL) return 'install';
  for (const reason of HELD) if (text === heldText(reason) || text === plainFailure('invalid_transition',{reason})) return `held:${reason}`;
  for (const code of TERMINALS) if (text === terminalText(code)) return `terminal:${code}`;
  if (text === plainFailure('unsupported')) return 'unsupported';
  if (text === plainFailure('queue_full')) return 'generic';
  throw new Error(`Unexpected owner-visible sentence: ${JSON.stringify(text)}`);
}
function check(condition, message) {
  if (!condition) throw new Error(message);
}
function harness(seed) {
  let time = 0, event, stretch = 0;
  const trace = [], lines = [], unresolved = new Map();
  const $ = {
    store:{get:async () => [],set:async () => {}},
    ui:{log:text => {
      check(!text.includes('could not finish connecting this conversation'),'I4: background notice shows the connect-failure sentence');
      lines.push({at:time,meaning:meaning(text),slot:event.slot,fork:event.fork ?? false,stretch});
    }},
  };
  const root = noticeEpisodes(() => time), fork = root.fork();
  return {
    seed,trace,lines,
    call(next) {
      check(next.at >= time,'Generated trace moved time backwards');
      event = next;time = next.at;trace.push(next);
      const member = next.fork ? fork : root;
      const producer = `${next.fork ? 'fork' : 'root'}:${next.slot}`;
      function retire() {
        unresolved.delete(producer);
        if (!unresolved.size) stretch += 1;
      }
      if (next.kind === 'good') {
        if (unresolved.has(producer)) {
          const good = unresolved.get(producer) + 1;
          if (good === 3) retire();else unresolved.set(producer,good);
        }
        member.good($,next.slot);return;
      }
      // Real failures interrupt recovery; idle refusals cannot create a stretch.
      if (next.kind !== 'lease' || unresolved.has(producer)) unresolved.set(producer,0);
      if (next.kind === 'lease') {
        member.fail($,next.slot,error('not_found',{reason:'lease_invalid'}),null);return;
      }
      if (next.kind === 'retry') {
        member.fail($,next.slot,error(next.code),RETRY,RETRY);return;
      }
      if (next.kind === 'held') {
        member.fail($,next.slot,error('invalid_transition',{reason:next.reason}),next.canonical ? plainFailure('invalid_transition',{reason:next.reason}) : heldText(next.reason),RETRY);return;
      }
      if (next.kind === 'advice') {
        member.fail($,next.slot,error(next.code),plainFailure(next.code),RETRY);return;
      }
      if (next.kind === 'install') {
        let failure = next.raw ? Object.assign(new Error('Fixture diagnostic.'),{code:'ENOENT'}) : error('incompatible_adapter');
        if (next.api !== undefined) {
          try {envelope({exitCode:0,stdout:JSON.stringify({api_version:next.api,ok:true,data:{}})});}
          catch (cause) {failure = cause;}
        }
        const before = lines.length, previous = lines.at(-1);
        member.fail($,next.slot,failure,INSTALL,RETRY);
        if (previous?.stretch !== stretch || previous?.meaning !== 'install') {
          check(lines.length === before + 1,'I3: changed installation failure was not immediate');
        }
        return;
      }
      check(next.kind === 'terminal','Unknown fixture event');
      const before = lines.length;
      member.fail($,next.slot,error(next.code),terminalText(next.code),RETRY,{terminal:true,key:`terminal:${next.code}`});
      check(lines.length === before + 1,'I3: terminal failure was not immediate');
      retire();
    },
  };
}
function generated(name, exercise) {
  it(name,() => {
    let failed = 0, first;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const h = harness(seed);
      try {exercise(h,random(seed));checkCap(h.lines);checkConsecutive(h.lines);}
      catch (failure) {
        failed += 1;
        first ??= {
          seed,message:failure.message,
          trace:h.trace.map(event => [event.at,event.slot,event.fork ? 'fork' : 'root',event.kind,event.code ?? event.reason ?? (event.raw ? 'ENOENT' : null)]),
          lines:h.lines.map(line => [line.at,line.slot,line.fork ? 'fork' : 'root',line.meaning]),
        };
      }
    }
    expect(failed,`${failed}/${SEEDS} generated sequences failed; seed and trace:\n${JSON.stringify(first)}`).toBe(0);
  });
}
function checkCap(lines) {
  const nonurgent = lines.filter(line => line.meaning !== 'install' && !line.meaning.startsWith('terminal:'));
  for (let i = 1; i < nonurgent.length; i += 1) {
    check(nonurgent[i].at - nonurgent[i - 1].at >= 2 * MINUTE,'I6: shared nonurgent cap exceeded (one line per two minutes)');
  }
}
function checkConsecutive(lines) {
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].stretch !== lines[i - 1].stretch || lines[i].meaning.startsWith('terminal:')) continue;
    check(lines[i].meaning !== lines[i - 1].meaning,'I2: consecutive identical visible meanings in an unrecovered stretch');
  }
}
function scope(rng) {return {slot:SLOTS[rng(SLOTS.length)],fork:Boolean(rng(2))};}
function retry(at, where, code) {return {at,...where,kind:'retry',code};}
function held(at, where, reason) {return {at,...where,kind:'held',reason};}

describe('generated background notice invariants (3,072 seeded sequences)',() => {
  generated('I1 finding 1: alternating host_unreachable/store_busy every 30 seconds cannot remain silent', (h,rng) => {
    const where = scope(rng), codes = rng(2) ? ['host_unreachable','store_busy'] : ['store_busy','host_unreachable'];
    for (let at = 0; at <= 10 * MINUTE; at += 30000) h.call(retry(at,where,codes[(at / 30000) % 2]));
    check(h.lines.some(line => line.at <= 2 * MINUTE + 30000),'I1: no notice by two minutes plus one call interval');
    checkConsecutive(h.lines);checkCap(h.lines);
  });

  generated('I1: overlapping transient failures retain their grace while responsibility moves between slots and forks', (h,rng) => {
    let previous = scope(rng);
    h.call(retry(0,previous,TRANSIENTS[rng(TRANSIENTS.length)]));
    for (let at = 30000; at <= 10 * MINUTE; at += 30000) {
      let next;
      do {next = scope(rng);} while (next.slot === previous.slot && next.fork === previous.fork);
      // The next producer fails before the previous producer recovers. There is
      // always a real failure, although no individual producer fails for 2 min.
      h.call(retry(at,next,TRANSIENTS[rng(TRANSIENTS.length)]));
      for (let i = 1; i <= 3; i += 1) h.call({at:at + i * 1000,...previous,kind:'good'});
      previous = next;
    }
    check(h.lines.some(line => line.at <= 150000),'I1: overlapping failures kept restarting the shared grace clock');
    checkConsecutive(h.lines);
  });

  generated('I2: codes with identical owner advice share one meaning across all slots and forks', (h,rng) => {
    const codes = rng(2) ? ['unsupported','unsupported_host_version'] : ['queue_full','revision_conflict','capacity_exceeded'];
    for (let i = 0; i < 64; i += 1) h.call({at:i * 30000,...scope(rng),kind:'advice',code:codes[rng(codes.length)]});
    check(h.lines.length === 1,'I2: identical owner-facing advice printed again when its diagnostic code changed');
    checkConsecutive(h.lines);
  });

  generated('I2: claim and report wording for the same held state cannot multiply advice', (h,rng) => {
    const reason = HELD[rng(HELD.length)], fork = Boolean(rng(2));
    for (let i = 0; i < SLOTS.length; i += 1) h.call(held(i * 1000,{slot:SLOTS[i],fork},reason));
    for (const start of [120000,130000]) {
      for (let i = 0; i < SLOTS.length; i += 1) {
        h.call({...held(start + i * 1000,{slot:SLOTS[i],fork},reason),canonical:true});
      }
    }
    check(h.lines.length === 1,'I2: alternate words for the same held state repeated its meaning');
  });

  generated('I2 finding 4: typed missing resources and raw spawn ENOENT share one install meaning across slots and forks', (h,rng) => {
    const first = scope(rng);
    h.call({at:0,...first,kind:'install',raw:Boolean(rng(2))});
    check(h.lines.length === 1 && h.lines[0].meaning === 'install','I3: first broken installation notice was not immediate');
    let at = 0;
    for (let i = 1; i < 64; i += 1) {
      at += rng(2) ? 1000 : 30000;
      h.call({at,...scope(rng),kind:'install',raw:Boolean(rng(2))});
    }
    check(h.lines.length === 1,'I2: the same installation problem printed again in another slot or fork');
  });

  generated('I3: locally detected helper API incompatibility bypasses the cap immediately after a retry line', (h,rng) => {
    const where = scope(rng);
    h.call(retry(0,where,'store_busy'));h.call(retry(120000,where,'host_unreachable'));
    check(h.lines.length === 1,'Fixture retry must be visible before the urgent mismatch');
    h.call({at:121000,...scope(rng),kind:'install',api:2 + rng(100)});
    check(h.lines.length === 2 && h.lines.at(-1).meaning === 'install','I3: helper API mismatch waited behind the nonurgent cap');
    for (let i = 0; i < 64; i += 1) h.call({at:122000 + i * 1000,...scope(rng),kind:'install',api:2 + rng(100)});
    check(h.lines.length === 2,'I2: API mismatches repeated the shared install repair notice');
  });

  generated('I1/I2: all five transient codes and one or two successful calls retain one visible unhealthy stretch', (h,rng) => {
    const where = scope(rng);
    for (let i = 0; i < 64; i += 1) {
      const at = i * 30000;
      h.call(retry(at,where,TRANSIENTS[i % TRANSIENTS.length]));
      for (let good = 0, count = rng(3); good < count; good += 1) h.call({at,...where,kind:'good'});
    }
    check(h.lines.length === 1,'I1/I2: transient codes or fewer than three successes split one unhealthy stretch');
    check(h.lines[0].at <= 150000,'I1: transient failure visibility missed its deadline');
    const recoveredAt = 64 * 30000;
    for (let i = 0; i < 3; i += 1) h.call({at:recoveredAt,...where,kind:'good'});
    h.call(retry(recoveredAt + 1000,where,'store_busy'));
    h.call(retry(recoveredAt + 120999,where,'timeout'));
    check(h.lines.length === 1,'A recovered slot did not give the next transient episode its own grace');
    h.call(retry(recoveredAt + 121000,where,'io_error'));
    check(h.lines.length === 2,'Three real successful calls did not rearm a new visible episode');
    checkCap(h.lines);
  });

  generated('I2/I6: any two nonurgent meanings flapping for ten minutes remain bounded and do not repeat consecutively', (h,rng) => {
    const where = scope(rng), interval = rng(2) ? 1000 : 30000;
    const meanings = ['retry',...HELD], left = rng(meanings.length);
    const right = (left + 1 + rng(meanings.length - 1)) % meanings.length;
    for (let at = 0; at <= 10 * MINUTE; at += interval) {
      const selected = meanings[(at / interval) % 2 ? right : left];
      h.call(selected === 'retry' ? retry(at,where,TRANSIENTS[rng(TRANSIENTS.length)]) : held(at,where,selected));
    }
    check(h.lines.some(line => line.at <= 2 * MINUTE + interval),'I1: a continuous two-meaning unhealthy flap stayed silent beyond its deadline');
    check(h.lines.length <= 6,'I6: ten-minute two-meaning flap printed more than six nonurgent lines');
    checkConsecutive(h.lines);checkCap(h.lines);
  });

  generated('I3/I6: changed held states need ten seconds and two same-slot calls, with one cap shared across forks', (h,rng) => {
    const where = scope(rng), reason = HELD[rng(HELD.length)], changed = HELD[(HELD.indexOf(reason) + 1) % HELD.length];
    h.call(held(0,where,reason));
    check(h.lines.length === 1,'Initial held state should be visible immediately');
    // The cap has expired, but a newly observed changed state still needs its
    // own stable evidence. Activity in another slot cannot supply that evidence.
    h.call(held(180000,where,changed));
    check(h.lines.length === 1,'Changed held state printed on its first observation');
    h.call(held(181000,{slot:where.slot,fork:!where.fork},changed));
    check(h.lines.length === 1,'Another fork supplied stability for the changed slot');
    h.call(held(189999,where,changed));
    check(h.lines.length === 1,'Changed held state printed before ten seconds');
    h.call(held(190000,where,changed));
    check(h.lines.at(-1)?.meaning === `held:${changed}`,'I5: stable changed held state never replaced stale text');
    h.call(held(310000,where,reason));h.call(held(320000,where,reason));
    check(h.lines.at(-1)?.meaning === `held:${reason}`,'I5: returning A after A→B never replaced the stale B line');
    for (let i = 0; i < 64; i += 1) h.call(held(321000 + i * 1000,scope(rng),HELD[rng(HELD.length)]));
    checkCap(h.lines);checkConsecutive(h.lines);
  });

  generated('I5: random mixed prefixes settle to the current meaning after grace, debounce and the shared cap', (h,rng) => {
    let at = 0;
    for (let i = 0; i < 64; i += 1) {
      at += rng(2) ? 1000 : 30000;
      const where = scope(rng), kind = rng(8);
      if (kind < 2) h.call(retry(at,where,TRANSIENTS[rng(TRANSIENTS.length)]));
      else if (kind < 4) h.call(held(at,where,HELD[rng(HELD.length)]));
      else if (kind === 4) h.call({at,...where,kind:'install',raw:Boolean(rng(2))});
      else if (kind === 7) h.call({at,...where,kind:'terminal',code:TERMINALS[rng(TERMINALS.length)]});
      else h.call({at,...where,kind:kind === 5 ? 'lease' : 'good'});
    }
    const where = scope(rng), selected = rng(HELD.length + 1), tailStart = at;
    const wanted = selected === HELD.length ? 'retry' : `held:${HELD[selected]}`;
    for (at = tailStart + 30000; at <= tailStart + 6 * MINUTE; at += 30000) {
      h.call(selected === HELD.length ? retry(at,where,TRANSIENTS[rng(TRANSIENTS.length)]) : held(at,where,HELD[selected]));
    }
    check(h.lines.at(-1)?.meaning === wanted,`I5: stable current meaning ${wanted} did not replace the last line`);
    checkCap(h.lines);
  });

  generated('silent lease-only calls stay quiet and cannot open or age the next visible episode', (h,rng) => {
    for (let i = 0; i < 64; i += 1) h.call({at:i * 30000,...scope(rng),kind:rng(4) ? 'lease' : 'good'});
    check(h.lines.length === 0,'Silent lease-only calls produced a visible episode');
    const where = scope(rng), start = 64 * 30000;
    for (const offset of [0,1000,30000,119999]) {
      h.call(retry(start + offset,where,TRANSIENTS[rng(TRANSIENTS.length)]));
      check(h.lines.length === 0,'Silent lease history aged the next transient grace period');
    }
    h.call(retry(start + 120000,where,'store_busy'));
    check(h.lines.length === 1,'Visible transient episode did not mature after its own grace');
  });

  generated('I3: terminal outcomes are immediate, close their slot and may repeat in a new episode', (h,rng) => {
    const where = scope(rng);
    for (let i = 0; i < 64; i += 1) {
      const at = i * 1000, code = TERMINALS[rng(TERMINALS.length)];
      if (rng(2)) h.call(retry(at,where,TRANSIENTS[rng(TRANSIENTS.length)]));
      else h.call({at,...where,kind:'lease'});
      const before = h.lines.length;
      h.call({at,...where,kind:'terminal',code});
      check(h.lines.length === before + 1 && h.lines.at(-1).meaning === `terminal:${code}`,'I3: terminal outcome was delayed, suppressed or replaced');
    }
  });
});
