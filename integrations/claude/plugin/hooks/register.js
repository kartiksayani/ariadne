import installed from './installed.js';
import { BUSY, claimLoop } from './claims.js';
import { forget, qualify, recall, remember, setup } from './setup.js';
import { bounded, descriptorValid, ModError, uuid } from './contracts.js';
import { announcements } from './discovery.js';

// Claude's static validator follows `$` only inside this file, so imported
// helpers receive a facade whose members are spelled $.noun.event(...) here.
// Members are read lazily so session/plugin changes stay observable.
function pluginName($) {
  try { return $.plugin.name; } catch { return undefined; }
}
function pluginRoot($) {
  try { return $.plugin.root; } catch { return undefined; }
}
function host($) {
  return {
    get plugin() { return {name:pluginName($),root:pluginRoot($)}; },
    session:{id:() => $.session.id(),cwd:() => $.session.cwd(),version:() => $.session.version()},
    process:{run:(argv,options) => $.process.run(argv,options)},
    prompt:{submit:options => $.prompt.submit(options)},
    ui:{log:message => $.ui.log(message)},
    store:{get:key => $.store.get(key),set:(key,value) => $.store.set(key,value),delete:key => $.store.delete(key),keys:() => $.store.keys()},
  };
}

// Owner-facing text: plain words, no IDs or internal state names.
const TEXT = Object.freeze({
  ended:'This Claude conversation has ended; Ariadne did not change its connection.',
  inProgress:'Ariadne is already connecting or disconnecting this conversation. Try again in a moment.',
  notConnected:'This conversation is not connected to Ariadne.',
  reconnected:'Ariadne: this conversation is connected to its Ariadne session again.',
  retrying:'Ariadne: could not reconnect this conversation to its Ariadne session yet. It will keep trying while the Ariadne app is open.',
  elsewhere:'This Ariadne session is connected to another conversation.',
  closed:'Ariadne: the Ariadne session for this conversation is closed. It will reconnect if you reopen it in the app.',
  gone:'Ariadne: the Ariadne session for this conversation no longer exists. Run /ariadne-connect to connect again.',
  unreachable:'Ariadne: could not reach the Ariadne app. This conversation will show there once the app is running.',
});
// Codes with which the app refuses an announcement for a scope it no longer has.
const STALE_SCOPE = ['stale_generation','binding_mismatch','not_found','invalid_argument'];

function selectedSession(event) {
  if (typeof event?.args !== 'string' || event.args.length > 64) throw new ModError('Connect requires bounded SDK command arguments; use /ariadne-connect [session-id].');
  const argument = event.args.trim();
  if (argument === '') return null;
  if (!uuid(argument)) throw new ModError('Use /ariadne-connect followed by one canonical Ariadne session UUID.');
  return argument;
}

export function createRegister(descriptor, publish) {
  return on => registerModule(descriptor, on, publish);
}

function failure($, error) {
  // Only our bounded actionable messages are displayed; raw rejected host
  // promises, helper stderr and owner payloads are never reflected.
  $.ui.log(error instanceof ModError ? error.message : 'Ariadne helper unavailable; retain original IDs and check the app.');
}
async function checked($, action) {
  try { return await action(); }
  catch (error) { failure($,error); return {text:'Ariadne operation did not complete. See the local status message; retain original operation IDs.'}; }
}
// One owner notice per state: a slot prints again only after its text changes
// or the state clears.
function notice(state, h, slot, text) {
  if (state.notices.get(slot) === text) return;
  state.notices.set(slot,text);
  h.ui.log(text);
}
async function announce(state, h) {
  try {
    await state.discovery.announce(h,state.announcementScope);
    state.notices.delete('heartbeat');
  } catch (error) {
    let last = error;
    // A scope the app no longer has still leaves this conversation discoverable.
    if (state.announcementScope && STALE_SCOPE.includes(error?.code)) {
      try { await state.discovery.announce(h,null); state.notices.delete('heartbeat'); return; }
      catch (fallback) { last = fallback; }
    }
    notice(state,h,'heartbeat',last instanceof ModError && last.code === undefined ? last.message : TEXT.unreachable);
  }
}
async function heartbeat(state, $) {
  if (state.sessionEnded) return;
  await follow(state,$);
  if (state.sessionEnded || state.ownerTransition) return;
  await announce(state,host($));
  if (state.target && !state.loop) await autoConnect(state,$);
  else await drainRetired(state,host($));
}
async function tick(state, $) {
  await follow(state,$);
  if (state.loop) await state.loop.poll(host($));
  // A /clear that kept the conversation ID reconnects on the next tick, not
  // the next heartbeat; later failures are retried by the heartbeat.
  else if (state.reconnectSoon) await autoConnect(state,$);
  if (state.note) await deliverNote(state,$);
}
function pollLoop(state, $) {
  void tick(state,$);
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
async function transition(state, $, action) {
  if (state.ownerTransition) return {text:TEXT.inProgress};
  if (state.sessionEnded) return {text:TEXT.ended};
  state.ownerTransition = true;
  try {
    if (state.following) await state.following;
    const h = host($);
    // Finish what is in flight first: save pending reports and retry an
    // unconfirmed claim with its original ID. Refuse only if that fails.
    for (const loop of loops(state)) await loop.settle(h);
    if (state.sessionEnded) return {text:TEXT.ended};
    await drainRetired(state,h);
    const reason = busy(state);
    if (reason) return {text:BUSY[reason]};
    return await action();
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
  state.owner?.forget();
  void forget(h,state.claudeSessionId);
  if (!state.ownerTransition) void announce(state,h);
}
function createLoop(state, binding) {
  const loop = claimLoop(state.descriptor.helperPath,binding,{onEnded:h => bindingGone(state,h,loop)});
  return loop;
}
// Stops the loops of a conversation that is no longer current. Each reports
// that its conversation ended; unsaved reports are retried by later heartbeats.
async function retire(state, h) {
  const old = loops(state);
  state.loop = null;
  state.loopBinding = null;
  state.pending = null;
  state.announcementScope = null;
  state.note = null;
  state.owner?.forget();
  state.retired.push(...old);
  for (const loop of old) await loop.stop(h,true);
}
async function drainRetired(state, h) {
  const left = [];
  for (const loop of state.retired) if (!await loop.drain(h)) left.push(loop);
  state.retired = left;
  return left.length === 0;
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
  state.cleared = null;
  await retire(state,h);
  // The session now belongs to the new conversation; resuming the old one
  // later follows whatever this conversation is connected to then.
  if (followed) await forget(h,previous);
  state.target = await recall(h,id) ?? followed ?? null;
  for (const slot of ['auto','heartbeat']) state.notices.delete(slot);
  await announce(state,h);
  if (state.target) await autoConnect(state,$);
}
// Every reconnect rotates the generation. A note in the conversation (a meta
// row the model reads on its next turn, not a prompt) gives Claude the new
// routing, so its Ariadne commands keep working without an owner command.
function routingNote(binding) {
  const {binding_id,generation,session} = binding;
  return `Ariadne reconnected this conversation to session ${session.session_id} in project ${session.project_id} by itself. From now on use binding ${binding_id} and generation ${generation} in every ariadne command; any earlier binding or generation in this conversation is no longer current. If your context is fresh, run ariadne read once to rebuild it. This note is not a message from the owner; do not reply to it.`;
}
// A note the engine refuses (no conversation mounted yet) is retried on the
// poll tick; past that, the skill's stale_generation rule still applies.
const NOTE_TRIES = 30;
async function deliverNote(state, $) {
  const note = state.note;
  if (!note || note.sending) return;
  note.sending = true;
  note.tries += 1;
  try {
    await $.session.append({message:{type:'user',content:[{type:'text',text:routingNote(note.binding)}]}});
    if (state.note === note) state.note = null;
  } catch {
    if (state.note === note && note.tries >= NOTE_TRIES) state.note = null;
  } finally { note.sending = false; }
}
// Reconnects this conversation to its remembered Ariadne session without an
// owner command. Failures are retried quietly by the heartbeat.
async function autoConnect(state, $) {
  if (!state.target || state.loop || state.ownerTransition || state.sessionEnded || !state.qualified) return;
  const h = host($);
  state.reconnectSoon = false;
  state.ownerTransition = true;
  try {
    // The app accepts the new conversation once the old one's end is saved.
    if (!await drainRetired(state,h)) return;
    const result = await bind(state,$,state.target.session_id);
    if (!state.loop || result.text) return;
    state.note = {binding:result.result.binding,tries:0,sending:false};
    await deliverNote(state,$);
    notice(state,h,'auto',TEXT.reconnected);
  } catch (error) {
    if (error?.code === 'not_found') {
      state.target = null;
      await forget(h,state.claudeSessionId);
      notice(state,h,'auto',TEXT.gone);
    } else if (error?.code === 'invalid_transition') notice(state,h,'auto',TEXT.closed);
    // Still retried quietly: the other conversation may end or disconnect.
    else if (error?.code === 'binding_conflict') notice(state,h,'auto',TEXT.elsewhere);
    else notice(state,h,'auto',TEXT.retrying);
  } finally {
    state.ownerTransition = false;
    reopen(state);
  }
}
async function sessionStart(state, $, event, next) {
  if (state.started) {
    // A later start in the same process is a conversation change, never a second set of timers.
    await follow(state,$);
    if (state.target && !state.loop) void autoConnect(state,$);
    return next(event);
  }
  state.started = true;
  for (const [name,description] of [['ariadne-connect','Bind this original conversation to Ariadne'],['ariadne-status','Show the registered Ariadne connection'],['ariadne-disconnect','Disconnect Ariadne without stopping Claude']]) {
    await $.command.register({name,description,...(name === 'ariadne-connect' ? {argumentHint:'[session-id]'} : {})});
  }
  try { state.claudeSessionId = await $.session.id(); } catch { state.claudeSessionId = null; }
  // Discovery may describe an unqualified engine; only native inspection can
  // qualify it. Its heartbeat never enables the independent claim loop.
  if (descriptorValid(state.descriptor,{name:pluginName($),root:pluginRoot($)})) {
    state.announcementTimer = $.clock.every(30000,() => heartbeat(state,$));
    await announce(state,host($));
  }
  if (state.sessionEnded) return next(event);
  try {
    await qualify(host($),state.descriptor);
    state.qualified = true;
    startPolling(state,$);
  } catch (error) { failure($,error); }
  // `claude --resume` of a connected conversation reconnects it; a new
  // conversation has no remembered session and only announces itself.
  if (state.qualified && !state.sessionEnded) {
    state.target = await recall(host($),state.claudeSessionId);
    if (state.target) void autoConnect(state,$);
  }
  return next(event);
}
async function bind(state, $, requestedSessionId) {
  if (!state.qualified) {
    await qualify(host($),state.descriptor);
    state.qualified = true;
    startPolling(state,$);
  }
  if (state.sessionEnded) return {text:TEXT.ended};
  const h = host($);
  const result = await state.owner.connect(h,requestedSessionId);
  const reason = busy(state);
  if (reason) return {text:BUSY[reason]};
  const replaced = state.loop;
  state.loop = state.sessionEnded ? state.pending.loop : createLoop(state,result.binding);
  state.loopBinding = result.binding;
  state.pending = null;
  state.announcementScope = {binding_id:result.binding.binding_id,generation:result.binding.generation};
  if (replaced && replaced !== state.loop) await replaced.stop(h);
  if (state.sessionEnded) await state.loop.stop(h,true);
  else {
    state.target = result.binding.session;
    await remember(h,state.claudeSessionId,result.binding.session);
  }
  return {result};
}
async function connectTransition(state, $, requestedSessionId) {
  // Without a selector, reconnect the session this conversation followed.
  const chosen = requestedSessionId ?? state.target?.session_id ?? null;
  const bound = await bind(state,$,chosen);
  if (!bound.result) return bound;
  state.notices.delete('auto');
  // The command output below gives Claude the routing itself.
  state.note = null;
  const {binding} = bound.result;
  const guidance = chosen === null ? '' : '\nThis resumes an earlier session: read reconnect.md in the ariadne skill first.';
  const summary = `Ariadne connected: binding ${binding.binding_id}, generation ${binding.generation}.\nCommand: ${state.descriptor.helperPath}\nFile your work as you go; the ariadne skill has the rest.`;
  return {text:summary + guidance};
}
function connectRun(state, $, event) {
  return checked($,() => {
    const requestedSessionId = selectedSession(event);
    return transition(state,$,() => connectTransition(state,$,requestedSessionId));
  });
}
async function statusAction(state, $) {
  if (!state.qualified) await qualify(host($),state.descriptor);
  return {text:JSON.stringify({binding:await state.owner.status(host($)),local:state.loop?.status() ?? null})};
}
async function disconnectAction(state, $) {
  if (!state.qualified) await qualify(host($),state.descriptor);
  if (state.sessionEnded) return {text:TEXT.ended};
  const h = host($);
  // An explicit disconnect also cancels any automatic reconnect.
  state.target = null;
  state.note = null;
  state.notices.delete('auto');
  await forget(h,state.claudeSessionId);
  if (!state.owner.current()) return {text:TEXT.notConnected};
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
async function turnStart(state, $, event, next) {
  try { if (state.loop) await state.loop.start(host($),event); }
  catch (error) { failure($,error); }
  return next(event);
}
async function turnComplete(state, $, event, next) {
  // A retired loop still records the end of a turn it delivered.
  try { for (const loop of [state.loop,...state.retired]) if (loop) await loop.complete(host($),event); }
  catch (error) { failure($,error); }
  return next(event);
}
// /clear and /resume end this conversation but not the process: report the
// end, keep the timers, and follow the next conversation.
async function conversationEnded(state, $) {
  state.cleared = state.loopBinding?.session ?? state.target ?? null;
  // Reconnect even if Claude keeps the same conversation ID: then follow()
  // sees no change, and the next session.start or poll tick reconnects.
  state.target = state.cleared;
  state.reconnectSoon = state.target !== null;
  await retire(state,host($));
  await follow(state,$);
}
async function sessionEnd(state, $, event, next) {
  if (['clear','resume'].includes(event?.reason) && !state.sessionEnded) {
    await conversationEnded(state,$);
    return next(event);
  }
  state.sessionEnded = true;
  state.timer?.cancel();
  state.announcementTimer?.cancel();
  state.discovery.stop();
  if (state.loop) await state.loop.stop(host($),true);
  if (state.pending && state.pending.loop !== state.loop) await state.pending.loop.stop(host($),true);
  for (const loop of state.retired) await loop.drain(host($));
  return next(event);
}

function registerModule(descriptor, on, publish) {
  const state = {
    descriptor,
    timer: null,
    announcementTimer: null,
    announcementScope: null,
    loop: null,
    loopBinding: null,
    pending: null,
    qualified: false,
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
    // New routing the model has not been told yet (see routingNote).
    note: null,
    retired: [],
    following: null,
    notices: new Map(),
    discovery: announcements(descriptor),
    owner: null,
  };
  state.owner = descriptor ? setup(descriptor.helperPath,(h,binding) => savedBinding(state,h,binding),publish) : null;
  on('session.start',($,event,next) => sessionStart(state,$,event,next));
  on('command.run',{command:'ariadne-connect'},($,event) => connectRun(state,$,event));
  on('command.run',{command:'ariadne-status'},($) => checked($,() => statusAction(state,$)));
  on('command.run',{command:'ariadne-disconnect'},($) => checked($,() => transition(state,$,() => disconnectAction(state,$))));
  on('turn.start',($,event,next) => turnStart(state,$,event,next));
  on('turn.complete',($,event,next) => turnComplete(state,$,event,next));
  on('session.end',($,event,next) => sessionEnd(state,$,event,next));
}

export const register = on => registerModule(installed, on);
