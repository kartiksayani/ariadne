import installed from './installed.js';
import { BUSY, claimLoop } from './claims.js';
import { forget, qualify, recall, remember, setup } from './setup.js';
import { BACKGROUND_RETRY, bounded, descriptorValid, failureCode, folderFailure, ModError, conversationHealth, backgroundOutcome, plainFailure, uuid } from './contracts.js';
import { announcements } from './discovery.js';
import { prCommentsPrompt } from './pr-comments.js';

// Claude's static validator follows `$` only inside this file, so imported
// helpers receive a facade whose members are spelled $.noun.event(...) here.
// Members are read lazily so session/plugin changes stay observable.
function pluginName($) {
  try { return $.plugin.name; } catch { return undefined; }
}
function pluginRoot($) {
  try { return $.plugin.root; } catch { return undefined; }
}
function host($, background = true) {
  return {
    background,
    get plugin() { return {name:pluginName($),root:pluginRoot($)}; },
    session:{id:() => $.session.id(),cwd:() => $.session.cwd(),version:() => $.session.version()},
    process:{run:(argv,options) => $.process.run(argv,options)},
    prompt:{submit:options => $.prompt.submit(options)},
    ui:{log:message => $.ui.log(message)},
    store:{get:key => $.store.get(key),set:(key,value) => $.store.set(key,value),delete:key => $.store.delete(key),keys:() => $.store.keys()},
  };
}

// Async calls retain their conversation's writer. Reset retires that writer,
// so a late result can never repopulate the next conversation's health.
function healthFor(state) {
  const health = state.health, mine = () => state.health === health;
  return {
    call:($,producer) => mine() ? health.call($,producer) : () => {},
    record:($,producer,outcome) => {if (mine()) health.record($,producer,outcome);},
    retire:($,producer) => {if (mine()) health.retire($,producer);},
  };
}
const OK = Object.freeze({kind:'ok'});
function resetHealth(state) {
  state.health.reset();
  state.health = conversationHealth();
}

// Owner-facing text: plain words, no IDs or internal state names.
const TEXT = Object.freeze({
  ended:'This Claude conversation has ended; Ariadne did not change its connection.',
  inProgress:'Ariadne is already connecting or disconnecting this conversation. Try again in a moment.',
  // Missing memory proves nothing about the app: /reload-plugins empties it.
  notKnown:"This conversation's connection isn't known here (the plugin may have been reloaded). If Ariadne still shows this session connected, choose Disconnect on it in Ariadne.",
  reconnected:'Ariadne: this conversation is connected to its Ariadne session again.',
  elsewhere:'This Ariadne session is connected to another conversation.',
  closed:'Ariadne: the Ariadne session for this conversation is closed. It will reconnect if you reopen it in the app.',
  gone:'Ariadne: the Ariadne session for this conversation no longer exists. Run /ariadne-connect to connect again.',
  unreachable:"Ariadne can't be reached, so this session's work isn't being recorded. Open Ariadne and it will reconnect.",
  failure:'Ariadne could not finish connecting this conversation. Run /ariadne-connect again; if it keeps happening, update Ariadne and its Claude plugin.',
  connectAgain:'Ariadne has not finished connecting this conversation. Run /ariadne-connect again; if it keeps happening, check this session in Ariadne.',
  heartbeatRetry:BACKGROUND_RETRY,
});
// Codes with which the app refuses an announcement for a scope it no longer has.
const STALE_SCOPE = ['stale_generation','binding_mismatch','not_found','invalid_argument'];

function selectedSession(event) {
  if (typeof event?.args !== 'string' || event.args.length > 64) throw new ModError('Invalid connect arguments.','Copy the session from Ariadne, then run /ariadne-connect followed by what you copied.');
  const argument = event.args.trim();
  if (argument === '') return null;
  if (!uuid(argument)) throw new ModError('Invalid session selector.','Copy the session from Ariadne, then run /ariadne-connect followed by what you copied.');
  return argument;
}

// Tests pass `step`, run at each await of a connect (see connectGuard).
export function createRegister(descriptor, publish, step) {
  return on => registerModule(descriptor, on, publish, step);
}

// Only our bounded plain sentences are displayed; raw rejected host
// promises, helper stderr and owner payloads are never reflected.
function failureText(state, error, connect = false) {
  if (state.loopBinding && error instanceof ModError && error.code === 'host_unreachable' && error.plain === plainFailure('host_unreachable')) return TEXT.unreachable;
  if (!connect && failureCode(error) === 'incompatible_adapter') return plainFailure('incompatible_adapter');
  return (error instanceof ModError ? error.plain : undefined) ?? (connect ? TEXT.failure : TEXT.heartbeatRetry);
}
function failure(state, error) {
  return backgroundOutcome(error,failureText(state,error));
}
// Owner commands answer directly and never change background health.
async function checked(state, $, action, connect = false) {
  try { return await action(); }
  catch (error) { return {text:`That did not complete. ${failureText(state,error,connect)}`}; }
}
function notice(error, text, terminal = false) {
  return {kind:terminal ? 'terminal' : 'held',code:failureCode(error),text};
}
// One announce call. One skipped because another is in flight has nothing to report.
async function announce(state, h) {
  const settle = healthFor(state).call(h,'announce');
  try {
    await state.discovery.announce(h,state.announcementScope);
    settle(OK);
  } catch (error) {
    let last = error;
    // A scope the app no longer has still leaves this conversation discoverable.
    if (state.announcementScope && STALE_SCOPE.includes(error?.code)) {
      try { await state.discovery.announce(h,null); settle(OK); return; }
      catch (fallback) { last = fallback; }
    }
    settle(failure(state,last));
  }
}
// Startup and an owner command may overlap a heartbeat. Share qualification,
// and retry a rejected startup check instead of leaving intake silently off.
function qualifyConnection(state, $) {
  state.qualifying ??= qualify(host($),state.descriptor).then(() => {
    state.qualified = true;
    // A qualified connection never qualifies again, whoever asked: the
    // producer retires. An owner command may be asking, so this prints nothing.
    healthFor(state).retire(host($,false),'qualification');
    startPolling(state,$);
  }).finally(() => { state.qualifying = null; });
  return state.qualifying;
}
// One startup or heartbeat qualification call and its outcome.
async function qualification(state, $) {
  const health = healthFor(state), settle = health.call(host($),'qualification');
  try {
    await qualifyConnection(state,$);
    settle(OK);
    // The producer retired as it qualified; show what that changed.
    health.retire(host($),'qualification');
  } catch (error) {
    settle(failure(state,error));
  }
}
// Claude ends a conversation (/clear, /resume) before $.session.id() returns
// the next one, so for a moment it still returns the ended ID. Automatic
// reconnect never binds that ID until something shows a conversation runs on
// it: the ID changes (followChange), a main-thread turn starts (turnStart), or
// a heartbeat comes at least ENDED_HOLD_MS after the end (a Claude build that
// keeps the ID across /clear). The explicit /ariadne-connect is never held.
const ENDED_HOLD_MS = 5000;
function holdsEnded(state) {
  return state.ended !== null && state.claudeSessionId === state.ended.id;
}
function releaseEnded(state) {
  state.ended = null;
}
async function heartbeat(state, $) {
  if (state.sessionEnded) return;
  await follow(state,$);
  if (state.sessionEnded || state.ownerTransition) return;
  await announce(state,host($));
  if (!state.qualified) await qualification(state,$);
  if (holdsEnded(state) && Date.now() - state.ended.at >= ENDED_HOLD_MS) releaseEnded(state);
  if (state.target && !state.loop && !holdsEnded(state)) await autoConnect(state,$);
  else await drainRetired(state,host($));
}
async function tick(state, $) {
  await follow(state,$);
  if (state.loop) await state.loop.poll(host($));
  // After /clear the new conversation reconnects on the first tick that may
  // bind it; later failures are retried by the heartbeat.
  else if (state.reconnectSoon && !holdsEnded(state)) await autoConnect(state,$,true);
  if (state.note) await deliverNote(state,$);
}
function pollLoop(state, $) {
  return tick(state,$);
}
function startPolling(state, $) {
  if (!state.sessionEnded) state.timer ??= $.clock.every(1000,() => pollLoop(state,$));
}
function loops(state) {
  return [...new Set([state.loop,state.pending?.loop].filter(Boolean))];
}
function busy(state) {
  for (const loop of loops(state)) {
    const reason = loop.busy();
    if (reason) return reason;
  }
  return null;
}
// After an owner operation, the current loop admits claims again unless a
// different saved scope still waits for its connection to be published.
function reopen(state) {
  if (state.loop && (!state.pending || state.pending.loop === state.loop)) state.loop.reopen();
}
async function transition(state, $, action, recover = false) {
  if (state.ownerTransition) return {text:TEXT.inProgress};
  if (state.sessionEnded) return {text:TEXT.ended};
  state.ownerTransition = true;
  let reachable = false;
  try {
    // Act on the conversation running now: a switch since the last tick
    // retires the ended one first, so its reports drain below.
    await follow(state,$);
    const h = host($,false);
    // Finish what is in flight first: save pending reports and retry an
    // unconfirmed claim with its original ID. Refuse only if that fails.
    for (const loop of loops(state)) await loop.settle(h);
    if (recover) for (const loop of loops(state)) {
      if (await loop.recover(h)) {
        reachable = true;
        if (state.sessionEnded) return {text:TEXT.ended};
        if (loop.outstanding()) return {text:BUSY[loop.busy()] ?? TEXT.inProgress};
        if (state.loop === loop) { state.loop = null; state.loopBinding = null; }
        if (state.pending?.loop === loop) state.pending = null;
      }
    }
    if (state.sessionEnded) return {text:TEXT.ended};
    await drainRetired(state,h);
    const reason = busy(state);
    if (reason) return {text:BUSY[reason]};
    return await action();
  } catch (error) {
    // A project-folder failure keeps its own repair words.
    if (reachable && error instanceof ModError && error.code === 'host_unreachable' && !folderFailure(error)) error.plain = TEXT.connectAgain;
    throw error;
  } finally {
    state.ownerTransition = false;
    reopen(state);
  }
}
async function savedBinding(state, h, binding) {
  state.announcementScope = {binding_id:binding.binding_id,generation:binding.generation};
  if (!state.pending || state.pending.binding.binding_id !== binding.binding_id || state.pending.binding.generation !== binding.generation) {
    if (state.pending?.loop.outstanding()) throw new ModError('Original saved-scope lifecycle evidence remains pending; recover it before changing the binding.');
    const sameScope = state.loopBinding?.binding_id === binding.binding_id && state.loopBinding?.generation === binding.generation;
    state.pending = {binding,loop:sameScope ? state.loop : createLoop(state,binding)};
    // The saved scope owns lifecycle reporting before it owns claim admission.
    await state.pending.loop.quiesce();
  }
  if (state.sessionEnded) { await state.pending.loop.stop(h,true); return; }
  if (!await state.discovery.announce(h,state.announcementScope)) {
    throw new ModError('Bound announcement is pending or the original session ended; no claims were admitted.');
  }
}
// The app removed this binding or another connection replaced it. The loop has
// told the owner; stop following it and stay discoverable for a new connect.
function bindingGone(state, h, loop) {
  if (state.loop !== loop && state.pending?.loop !== loop) return;
  state.loop = null;
  state.loopBinding = null;
  state.pending = null;
  state.announcementScope = null;
  state.target = null;
  state.note = null;
  state.owner?.forget(h);
  void forget(h,state.claudeSessionId);
  if (!state.ownerTransition) void announce(state,h);
}
function createLoop(state, binding) {
  const loop = claimLoop(state.descriptor.helperPath,binding,{onEnded:h => bindingGone(state,h,loop),health:healthFor(state)});
  return loop;
}
// Stops the loops of a conversation that is no longer current. Each reports
// that its conversation ended; unsaved reports are retried by later heartbeats.
async function retire(state, h) {
  const old = loops(state);
  for (const binding of [state.loopBinding,state.pending?.binding]) if (binding) state.endedScopes.add(scopeKey(binding));
  state.loop = null;
  state.loopBinding = null;
  state.pending = null;
  state.announcementScope = null;
  state.note = null;
  const handed = state.owner?.forget(h,true) ?? null;
  state.retired.push(...old);
  if (handed) state.retired.push(retiredRequest(state,handed));
  for (const loop of old) await loop.stop(h,true);
}
function scopeKey(binding) {
  return `${binding.binding_id}:${binding.generation}`;
}
// Reports the end of a binding saved for a conversation that ended, through a
// stopped loop like any retired one: the session-end report needs no route, and
// a late activation of that generation cannot undo it. Once per binding scope.
async function endSaved(state, h, binding) {
  const key = scopeKey(binding);
  if (state.endedScopes.has(key)) return null;
  state.endedScopes.add(key);
  const loop = createLoop(state,binding);
  state.retired.push(loop);
  await loop.stop(h,true);
  return loop;
}
// A drain result: nothing failed, but a retired connect request may still commit.
const WAITING = Object.freeze({waiting:true});
// A connect request of a conversation that ended before its outcome was known.
// It is looked up, never sent again: a saved binding gets its session-end
// report; one that can no longer commit, or whose lookup can tell nothing more,
// is dropped (the bounds are setup's lookup); otherwise drainLoops asks again.
function retiredRequest(state, handed) {
  let loop = null, done = false;
  return {
    async drain(h) {
      if (done) return null;
      if (!loop) {
        let saved;
        try { saved = await state.owner.lookup(h,handed); }
        catch (error) { return error; }
        if (saved === undefined) return WAITING;
        if (saved === null) { done = true; return null; }
        loop = await endSaved(state,h,saved);
        // Already ended through another loop, which drains it.
        if (!loop) { done = true; return null; }
      }
      const error = await loop.drain(h);
      if (!error) done = true;
      return error;
    },
    // It never delivered a turn.
    complete:async () => {},
  };
}
// Retries the unsaved reports of retired loops. Returns the last failure,
// WAITING while a retired request may still commit, or null once nothing is
// left. Their stopped claim loops no longer poll.
// One drain runs at a time. A caller that finds one running waits for it and
// takes its result, unless something was retired after it looked (or `again`
// asks for a pass of its own): then it drains once more. A drain removes only
// the entries it finished, so a report retired while it waited stays queued.
async function drainLoops(state, h, again = false) {
  while (state.draining) {
    const running = state.draining, result = await running.done;
    if (state.draining) continue;
    if (!again && state.retired.every(loop => running.seen.has(loop))) return result;
    break;
  }
  const run = {seen:new Set(),done:null};
  run.done = drainPass(state,h,run.seen).finally(() => { if (state.draining === run) state.draining = null; });
  state.draining = run;
  return run.done;
}
async function drainPass(state, h, seen) {
  const finished = new Set();
  let failed = null, waiting = false;
  // Live: an entry retired while this pass waits is drained by it too.
  for (const loop of state.retired) {
    seen.add(loop);
    const error = await loop.drain(h);
    if (error === WAITING) waiting = true;
    else if (error) failed = error;
    else finished.add(loop);
  }
  state.retired = state.retired.filter(loop => !finished.has(loop));
  return failed ?? (waiting ? WAITING : null);
}
// One automatic-reconnect call; with nothing to drain it records ok. Retired
// reports block a background reconnect, so their real failure is kept. A
// request that may still commit holds it quietly, for at most LATE_COMMIT_MS.
async function drainRetired(state, h) {
  const settle = healthFor(state).call(h,'auto');
  const failed = await drainLoops(state,h);
  settle(failed && failed !== WAITING ? backgroundOutcome(failed) : OK);
  return failed === null;
}
// A new Claude conversation in this process (/clear, /resume) takes over: the
// old conversation's loop reports its end, and the new conversation follows the
// Ariadne session the old one used, or the one it was itself connected to.
function follow(state, $) {
  if (!state.started || state.sessionEnded) return Promise.resolve();
  state.following ??= followChange(state,$).finally(() => { state.following = null; });
  return state.following;
}
async function followChange(state, $) {
  let id;
  try { id = await $.session.id(); } catch { return; }
  if (!bounded(id) || id === state.claudeSessionId) return;
  const h = host($);
  const followed = state.cleared ?? state.loopBinding?.session ?? state.target;
  const previous = state.claudeSessionId;
  state.claudeSessionId = id;
  state.conversation += 1;
  // A new conversation starts with no health evidence or retry spacing; reset
  // with the counter, before any await (see conversationEnded).
  resetHealth(state);
  state.cleared = null;
  // A conversation runs on the new ID, so the ended one no longer holds reconnect.
  releaseEnded(state);
  await retire(state,h);
  // The session now belongs to the new conversation; resuming the old one
  // later follows whatever this conversation is connected to then.
  if (followed) await forget(h,previous);
  state.target = await recall(h,id) ?? followed ?? null;
  await announce(state,h);
  // Kept set if a connect still in flight for the old conversation makes this
  // one return early: the next tick tries again once it settles.
  state.reconnectSoon = state.target !== null;
  // Inside the follow itself: following again would wait for this call. A
  // /clear of this ID during the awaits above holds it (mayAutoConnect).
  if (state.target) await autoConnect(state,$,true);
}
// Every reconnect rotates the generation. A note in the conversation (a meta
// row the model reads on its next turn, not a prompt) gives Claude the new
// routing, so its Ariadne commands keep working without an owner command.
function routingNote(binding, helperPath, explicit = false) {
  const {binding_id,generation,session} = binding;
  const connected = explicit ? 'Ariadne connected this conversation at the owner’s request' : 'Ariadne reconnected this conversation by itself';
  return `${connected} to session ${session.session_id} in project ${session.project_id}. From now on use binding ${binding_id} and generation ${generation} in every ariadne command; any earlier binding or generation in this conversation is no longer current.\n${commandLine(helperPath)}\nIf your context is fresh, read reconnect.md in the ariadne skill first. This note is not a message from the owner; do not reply to it.`;
}
// The skill tells the agent to run this path verbatim, so a path with a space or
// another shell-special character is single-quoted here.
function shellQuote(path) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'","'\\''")}'`;
}
function commandLine(helperPath) {
  return `Command: ${shellQuote(helperPath)}`;
}
// A note the engine refuses (no conversation mounted yet) is retried on the
// poll tick; past that, the skill's stale_generation rule still applies.
const NOTE_TRIES = 30;
// Never awaited by a connect: a hung append must not hold an owner command.
// The note belongs to the conversation its connect ran in (`note.guard`): it
// is checked right before the append, and nothing is appended after a change.
async function deliverNote(state, $) {
  const note = state.note;
  if (!note || note.sending) return;
  note.sending = true;
  try {
    if (state.step) await state.step('note');
    if (state.note !== note || note.guard?.spanned()) {
      if (state.note === note) state.note = null;
      return;
    }
    note.tries += 1;
    await $.session.append({message:{type:'user',content:[{type:'text',text:routingNote(note.binding,state.descriptor.helperPath,note.explicit)}]}});
    if (state.note === note) state.note = null;
  } catch {
    if (state.note === note && note.tries >= NOTE_TRIES) state.note = null;
  } finally { note.sending = false; }
}
// Reconnects this conversation to its remembered Ariadne session without an
// owner command. Failures are retried quietly by the heartbeat.
// An ended ID is held for every automatic caller (see holdsEnded), including
// one whose conversation ended while it awaited something else first.
function mayAutoConnect(state) {
  return state.target && !state.loop && !state.ownerTransition && !state.sessionEnded && state.qualified && !holdsEnded(state);
}
// `followed`: the caller read the conversation ID just before (tick,
// followChange); otherwise it is read here first, as the tick does, so the
// guard holds the ID the connect sends.
async function autoConnect(state, $, followed = false) {
  if (!mayAutoConnect(state)) return;
  if (!followed) {
    const counter = state.conversation;
    await follow(state,$);
    // A conversation change reconnects through followChange or the next tick.
    if (state.conversation !== counter || !mayAutoConnect(state)) return;
  }
  // Captured before anything else is awaited: a conversation end while the
  // retired reports drain fences this reconnect too.
  const guard = connectGuard(state,host($));
  state.reconnectSoon = false;
  state.ownerTransition = true;
  // One automatic-reconnect call with one outcome.
  const settle = healthFor(state).call(guard.h,'auto');
  let outcome = OK;
  try { outcome = await reconnect(state,$,guard); }
  catch (error) { outcome = failure(state,error); throw error; }
  finally {
    settle(outcome);
    state.ownerTransition = false;
    reopen(state);
  }
}
async function reconnect(state, $, guard) {
  const {h} = guard;
  try {
    // The app accepts the new conversation once the old one's end is saved.
    const failed = await guard.step('drain',drainLoops(state,h));
    if (failed === WAITING) return OK;
    if (failed) return backgroundOutcome(failed);
    if (!state.target) return OK;
    const result = await guard.step('bind',bind(state,$,state.target.session_id,guard));
    if (!state.loop || result.text) return OK;
    // The guard looked last as `bind` settled; the note goes out after this.
    h.ui.log(TEXT.reconnected);
    state.note = {binding:result.result.binding,guard,tries:0,sending:false};
    void deliverNote(state,$);
    return OK;
  } catch (error) {
    // The conversation ended or changed: the next one reconnects itself, quietly.
    if (error === SPANNED || guard.spanned()) return OK;
    if (error?.code === 'not_found') {
      state.target = null;
      await forget(h,state.claudeSessionId);
      return notice(error,TEXT.gone,true);
    }
    if (error?.code === 'invalid_transition') return notice(error,TEXT.closed);
    // Still retried quietly: the other conversation may end or disconnect.
    if (error?.code === 'binding_conflict') return notice(error,TEXT.elsewhere);
    return failure(state,error);
  }
}
async function sessionStart(state, $, event, next) {
  if (state.started) {
    // A later start in the same process is a conversation change, never a second set of timers.
    await follow(state,$);
    if (state.target && !state.loop) void autoConnect(state,$,true);
    return next(event);
  }
  state.started = true;
  for (const [name,description] of [['ariadne-connect','Bind this original conversation to Ariadne'],['ariadne-status','Show the registered Ariadne connection'],['ariadne-disconnect','Disconnect Ariadne without stopping Claude']]) {
    await $.command.register({name,description,...(name === 'ariadne-connect' ? {argumentHint:'[session-id]'} : {})});
  }
  await $.command.register({name:'ariadne-pr-comments',description:'Choose what to do with open PR review comments',argumentHint:'<PR>'});
  try { state.claudeSessionId = await $.session.id(); } catch { state.claudeSessionId = null; }
  // Discovery may describe an unqualified engine; only native inspection can
  // qualify it. Its heartbeat never enables the independent claim loop.
  if (descriptorValid(state.descriptor,{name:pluginName($),root:pluginRoot($)})) {
    state.announcementTimer = $.clock.every(30000,() => heartbeat(state,$));
    await announce(state,host($));
  }
  if (state.sessionEnded) return next(event);
  await qualification(state,$);
  // `claude --resume` of a connected conversation reconnects it; a new
  // conversation has no remembered session and only announces itself.
  if (!state.sessionEnded) {
    state.target = await recall(host($),state.claudeSessionId);
    if (state.qualified && state.target) void autoConnect(state,$);
  }
  return next(event);
}
// Connects the conversation `guard` belongs to; every await is one of its steps.
async function bind(state, $, requestedSessionId, guard) {
  const {h} = guard;
  if (!state.qualified) await guard.step('qualify',qualifyConnection(state,$));
  if (state.sessionEnded) return {text:TEXT.ended};
  // A binding this connect saved is the guard's to end from here on.
  // Setup sends the guard's ID, never a fresh read that may name another conversation.
  const result = await guard.step('connect',state.owner.connect(h,requestedSessionId,{background:h.background,external:guard.id}),value => value.binding);
  const reason = busy(state);
  if (reason) return {text:BUSY[reason]};
  const replaced = state.loop;
  state.loop = state.sessionEnded ? state.pending.loop : createLoop(state,result.binding);
  state.loopBinding = result.binding;
  state.pending = null;
  state.announcementScope = {binding_id:result.binding.binding_id,generation:result.binding.generation};
  // From here a conversation end retires the loop armed above, which reports
  // the binding's end.
  if (replaced && replaced !== state.loop) await guard.step('replaced',replaced.stop(h));
  if (state.sessionEnded) await guard.step('stop',state.loop.stop(h,true));
  else {
    state.target = result.binding.session;
    await guard.step('remember',remember(h,guard.id,result.binding.session));
  }
  return {result};
}
function sameScope(a, b) {
  return a?.binding_id === b.binding_id && a?.generation === b.generation;
}
// Stops a connect whose conversation ended or changed (see connectGuard).
const SPANNED = Object.freeze({spanned:true});
// A connect belongs to the conversation it started in. Each await on its path
// is one `step`: when the step settles, the guard looks at the conversation
// again (counter, ID and health). Once it changed, the connect fences once and
// stops with SPANNED, so nothing it does reaches the next conversation: it
// ends the binding it saved, releases it, and forgets the ended ID's memory a
// late write may have brought back. A connect in the same conversation is
// never fenced.
function connectGuard(state, h) {
  const health = state.health, id = state.claudeSessionId, counter = state.conversation;
  const spanned = () => state.health !== health || state.claudeSessionId !== id || state.conversation !== counter;
  let saved = null, fenced = null;
  async function stop() {
    // Only this connect saves a binding once its conversation ended (retire
    // cleared the rest), so a pending one is its own.
    fenced ??= (async () => {
      const binding = saved ?? state.pending?.binding ?? null;
      if (binding) {
        if (state.note && sameScope(state.note.binding,binding)) state.note = null;
        await fence(state,h,binding);
      }
      if (state.claudeSessionId !== id) await forget(h,id);
    })();
    await fenced;
    throw SPANNED;
  }
  return {h,id,spanned,
    // Awaits `work`; `owns` names the binding its value saved.
    async step(name, work, owns = null) {
      let value, failure = null, failed = false;
      try { value = await work; }
      catch (error) { failed = true; failure = error; }
      if (!failed && owns) saved = owns(value);
      if (state.step) await state.step(name);
      if (failure === SPANNED || spanned()) await stop();
      if (failed) throw failure;
      return value;
    },
  };
}
// Ends a binding saved for a conversation that ended while its connect ran:
// nothing here follows it any more, and its session-end report is queued once.
async function fence(state, h, binding) {
  const pending = state.pending && sameScope(state.pending.binding,binding) ? state.pending : null;
  if (pending) state.pending = null;
  if (sameScope(state.announcementScope,binding)) state.announcementScope = null;
  state.owner.release(binding);
  if (!pending) { await endSaved(state,h,binding); return; }
  const key = scopeKey(binding);
  if (state.endedScopes.has(key)) return;
  state.endedScopes.add(key);
  state.retired.push(pending.loop);
  await pending.loop.stop(h,true);
}
async function connectTransition(state, $, requestedSessionId) {
  // Read the conversation ID again as the tick does (transition's own read
  // came before its awaits), so the guard holds the ID the connect sends and
  // that tick's follow is no change.
  await follow(state,$);
  if (state.sessionEnded) return {text:TEXT.ended};
  // Before session.start nothing follows; the connect's ID is read here.
  if (!bounded(state.claudeSessionId)) state.claudeSessionId = await $.session.id();
  // Without a selector, reconnect the session this conversation followed.
  const chosen = requestedSessionId ?? state.target?.session_id ?? null;
  const guard = connectGuard(state,host($,false));
  try {
    const bound = await guard.step('bind',bind(state,$,chosen,guard));
    if (!bound.result) return bound;
    // Give Claude its routing through the existing note, after the guard's
    // last look (the answer never waits for it); keep owner output plain.
    const guidance = chosen === null ? '' : '\nThis resumes an earlier session: read reconnect.md in the ariadne skill first.';
    state.note = {binding:bound.result.binding,explicit:true,guard,tries:0,sending:false};
    void deliverNote(state,$);
    const summary = 'This conversation is connected to Ariadne. File your work as you go; the ariadne skill has the rest.';
    return {text:summary + guidance};
  } catch (error) {
    if (error === SPANNED) return {text:TEXT.connectAgain};
    throw error;
  }
}
function connectRun(state, $, event) {
  return checked(state,$,() => {
    const requestedSessionId = selectedSession(event);
    return transition(state,$,() => connectTransition(state,$,requestedSessionId),true);
  },true);
}
async function prCommentsRun(state, $, event) {
  let text;
  try { text = prCommentsPrompt(event?.args); }
  catch (error) { return {text:error.plain}; }
  await follow(state,$);
  if (state.sessionEnded) return {text:TEXT.ended};
  if (!state.loopBinding || !state.loop) return {text:'Connect this conversation with /ariadne-connect first.'};
  if (state.ownerTransition || busy(state)) return {text:'Ariadne is still handling another request. Try again when it finishes.'};
  // Like owner-input submissions, this promise can span the model's whole turn.
  // Never await it in the command handler or automatically retry uncertain delivery.
  try {
    void $.prompt.submit({text,asUser:true}).then(result => {
      if (typeof result?.drop === 'string') $.ui.log('The PR comments request did not start. Run /ariadne-pr-comments again.');
    }).catch(() => $.ui.log('The PR comments request may not have started. Check the conversation before trying again.'));
  } catch { return {text:'The PR comments request may not have started. Check the conversation before trying again.'}; }
  return {text:'The agent will file the review choices in Ariadne. Pick Fix, Reply or Skip there.'};
}
async function statusAction(state, $) {
  if (!state.qualified) await qualifyConnection(state,$);
  return {text:JSON.stringify({binding:await state.owner.status(host($,false)),local:state.loop?.status() ?? null})};
}
async function disconnectAction(state, $) {
  if (!state.qualified) await qualifyConnection(state,$);
  if (state.sessionEnded) return {text:TEXT.ended};
  const h = host($,false);
  // An explicit disconnect also cancels any automatic reconnect.
  state.target = null;
  state.note = null;
  state.owner?.endBackground(h);
  await forget(h,state.claudeSessionId);
  if (!state.owner.current()) return {text:TEXT.notKnown};
  if (state.loop) await state.loop.stop(h);
  const receipt = await state.owner.disconnect(h);
  const reason = busy(state);
  if (reason) return {text:BUSY[reason]};
  state.loop = null;
  state.loopBinding = null;
  state.pending = null;
  state.announcementScope = null;
  return {text:JSON.stringify(receipt)};
}
// Each turn callback is one helper call; with no loop to tell it records ok.
async function turnStart(state, $, event, next) {
  // A main-thread turn shows a conversation runs on this ID, even one that
  // /clear kept: the next tick reconnects it.
  if (event?.agentId === undefined) releaseEnded(state);
  const settle = healthFor(state).call(host($),'helper'), loop = state.loop;
  try { if (loop) await loop.start(host($),event); settle(OK); }
  catch (error) { settle(failure(state,error)); }
  return next(event);
}
async function turnComplete(state, $, event, next) {
  const settle = healthFor(state).call(host($),'helper');
  // A retired loop still records the end of a turn it delivered.
  const active = [state.loop,...state.retired].filter(Boolean);
  try {
    for (const loop of active) await loop.complete(host($),event);
    settle(OK);
  }
  catch (error) { settle(failure(state,error)); }
  return next(event);
}
// /clear and /resume end this conversation but not the process: report the
// end, keep the timers, and follow the next conversation.
async function conversationEnded(state, $, event) {
  // The ended ID comes from the event or from what this conversation was
  // following; a fresh $.session.id() may already be the next conversation's.
  const ended = bounded(event?.sessionId) ? event.sessionId : state.claudeSessionId;
  if (bounded(ended)) state.ended = {id:ended,at:Date.now()};
  state.conversation += 1;
  // With the counter, before any await: a connect that starts while the end
  // report is sent belongs to the next conversation and must not be fenced.
  resetHealth(state);
  state.cleared = state.loopBinding?.session ?? state.target ?? null;
  // Reconnect even if Claude keeps the same conversation ID: then follow()
  // sees no change, and the first turn or the next heartbeat reconnects.
  state.target = state.cleared;
  state.reconnectSoon = state.target !== null;
  await retire(state,host($));
  await follow(state,$);
}
async function sessionEnd(state, $, event, next) {
  if (['clear','resume'].includes(event?.reason) && !state.sessionEnded) {
    await conversationEnded(state,$,event);
    return next(event);
  }
  state.sessionEnded = true;
  state.owner?.endBackground(host($));
  state.timer?.cancel();
  state.announcementTimer?.cancel();
  state.discovery.stop();
  if (state.loop) await state.loop.stop(host($),true);
  if (state.pending && state.pending.loop !== state.loop) await state.pending.loop.stop(host($),true);
  // The last try for every retired report, after any drain already running.
  await drainLoops(state,host($),true);
  return next(event);
}

function registerModule(descriptor, on, publish, step = null) {
  const state = {
    descriptor,
    timer: null,
    announcementTimer: null,
    announcementScope: null,
    loop: null,
    loopBinding: null,
    pending: null,
    qualified: false,
    qualifying: null,
    ownerTransition: false,
    sessionEnded: false,
    started: false,
    claudeSessionId: null,
    // The Ariadne session this conversation reconnects to without a command.
    target: null,
    // The session the conversation ended by /clear or /resume was using.
    cleared: null,
    // Set by /clear: reconnect on the next poll tick instead of the heartbeat.
    reconnectSoon: false,
    // The conversation /clear or /resume ended, {id, at}, while $.session.id()
    // may still return it (see holdsEnded).
    ended: null,
    // Counts conversation ends and changes; a connect that spans one is fenced.
    conversation: 0,
    // Binding scopes whose session-end report is already queued here.
    endedScopes: new Set(),
    // New routing the model has not been told yet (see routingNote).
    note: null,
    retired: [],
    // The drain of `retired` running now, {seen, done} (see drainLoops).
    draining: null,
    following: null,
    health: conversationHealth(),
    discovery: announcements(descriptor),
    owner: null,
    step,
  };
  state.owner = descriptor ? setup(descriptor.helperPath,(h,binding) => savedBinding(state,h,binding),publish) : null;
  on('session.start',($,event,next) => sessionStart(state,$,event,next));
  on('command.run',{command:'ariadne-connect'},($,event) => connectRun(state,$,event));
  on('command.run',{command:'ariadne-pr-comments'},($,event) => prCommentsRun(state,$,event));
  on('command.run',{command:'ariadne-status'},($) => checked(state,$,() => statusAction(state,$)));
  on('command.run',{command:'ariadne-disconnect'},($) => checked(state,$,() => transition(state,$,() => disconnectAction(state,$))));
  on('turn.start',($,event,next) => turnStart(state,$,event,next));
  on('turn.complete',($,event,next) => turnComplete(state,$,event,next));
  on('session.end',($,event,next) => sessionEnd(state,$,event,next));
}

export const register = on => registerModule(installed, on);
