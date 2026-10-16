import installed from './installed.js';
import { BUSY, claimLoop } from './claims.js';
import { forget, qualify, recall, remember, setup } from './setup.js';
import { BACKGROUND_RETRY, bounded, descriptorValid, failureCode, ModError, noticeEpisodes, plainFailure, uuid } from './contracts.js';
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
  retrying:BACKGROUND_RETRY,
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

export function createRegister(descriptor, publish) {
  return on => registerModule(descriptor, on, publish);
}

// Only our bounded plain sentences are displayed; raw rejected host
// promises, helper stderr and owner payloads are never reflected.
function failureText(state, error, connect = false) {
  if (state.loopBinding && error instanceof ModError && error.code === 'host_unreachable' && error.plain === plainFailure('host_unreachable')) return TEXT.unreachable;
  if (!connect && failureCode(error) === 'incompatible_adapter') return plainFailure('incompatible_adapter');
  return (error instanceof ModError ? error.plain : undefined) ?? (connect ? TEXT.failure : TEXT.heartbeatRetry);
}
function failure(state, $, error, connect = false, background = true) {
  return state.notices.fail(host($),'helper',error,failureText(state,error,connect),TEXT.heartbeatRetry,{background});
}
// A command always answers the owner, even when its log line was already shown.
async function checked(state, $, action, connect = false) {
  try {
    const result = await action();
    await state.notices.good(host($),'helper');
    return result;
  } catch (error) { await failure(state,$,error,connect,false); return {text:`That did not complete. ${failureText(state,error,connect)}`}; }
}
function notice(state, h, slot, error, text, key, terminal = false) {
  return state.notices.fail(h,slot,error,text,text,{key,terminal});
}
function announcementGood(state, h) {
  state.notices.good(h,'announce');
  state.notices.good(h,'helper');
  if (state.qualified) state.notices.good(h,'qualification');
}
async function announce(state, h) {
  try {
    if (await state.discovery.announce(h,state.announcementScope)) {
      announcementGood(state,h);
    }
  } catch (error) {
    let last = error;
    // A scope the app no longer has still leaves this conversation discoverable.
    if (state.announcementScope && STALE_SCOPE.includes(error?.code)) {
      try { if (await state.discovery.announce(h,null)) announcementGood(state,h); return; }
      catch (fallback) { last = fallback; }
    }
    await state.notices.fail(h,'announce',last,failureText(state,last),TEXT.heartbeatRetry);
  }
}
// Startup and an owner command may overlap a heartbeat. Share qualification,
// and retry a rejected startup check instead of leaving intake silently off.
function qualifyConnection(state, $) {
  state.qualifying ??= qualify(host($),state.descriptor).then(() => {
    state.qualified = true;
    startPolling(state,$);
  }).finally(() => { state.qualifying = null; });
  return state.qualifying;
}
async function heartbeat(state, $) {
  if (state.sessionEnded) return;
  await follow(state,$);
  if (state.sessionEnded || state.ownerTransition) return;
  await announce(state,host($));
  if (!state.qualified) {
    try {
      await qualifyConnection(state,$);
      await state.notices.good(host($),'qualification');
    } catch (error) {
      await state.notices.fail(host($),'qualification',error,failureText(state,error),TEXT.heartbeatRetry);
    }
  }
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
    if (state.following) await state.following;
    const h = host($);
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
    if (reachable && error instanceof ModError && error.code === 'host_unreachable') error.plain = TEXT.connectAgain;
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
  const loop = claimLoop(state.descriptor.helperPath,binding,{onEnded:h => bindingGone(state,h,loop),notices:state.notices.fork()});
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
  state.owner?.forget(h);
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
  // The new conversation has seen none of these, so each may print again (a closed app included).
  state.notices.reset();
  await announce(state,h);
  if (state.target) await autoConnect(state,$);
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
async function deliverNote(state, $) {
  const note = state.note;
  if (!note || note.sending) return;
  note.sending = true;
  note.tries += 1;
  try {
    await $.session.append({message:{type:'user',content:[{type:'text',text:routingNote(note.binding,state.descriptor.helperPath,note.explicit)}]}});
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
    const result = await bind(state,$,state.target.session_id,{background:true});
    if (!state.loop || result.text) return;
    state.note = {binding:result.result.binding,tries:0,sending:false};
    await deliverNote(state,$);
    state.notices.delete('auto');
    h.ui.log(TEXT.reconnected);
  } catch (error) {
    if (error?.code === 'not_found') {
      state.target = null;
      await forget(h,state.claudeSessionId);
      notice(state,h,'auto',error,TEXT.gone,'auto:gone',true);
    } else if (error?.code === 'invalid_transition') notice(state,h,'auto',error,TEXT.closed,'auto:closed');
    // Still retried quietly: the other conversation may end or disconnect.
    else if (error?.code === 'binding_conflict') notice(state,h,'auto',error,TEXT.elsewhere,'auto:conflict');
    else await state.notices.fail(h,'auto',error,failureText(state,error),TEXT.retrying);
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
  await $.command.register({name:'ariadne-pr-comments',description:'Choose what to do with open PR review comments',argumentHint:'<PR>'});
  try { state.claudeSessionId = await $.session.id(); } catch { state.claudeSessionId = null; }
  // Discovery may describe an unqualified engine; only native inspection can
  // qualify it. Its heartbeat never enables the independent claim loop.
  if (descriptorValid(state.descriptor,{name:pluginName($),root:pluginRoot($)})) {
    state.announcementTimer = $.clock.every(30000,() => heartbeat(state,$));
    await announce(state,host($));
  }
  if (state.sessionEnded) return next(event);
  try {
    await qualifyConnection(state,$);
  } catch (error) { await state.notices.fail(host($),'qualification',error,failureText(state,error),TEXT.heartbeatRetry); }
  // `claude --resume` of a connected conversation reconnects it; a new
  // conversation has no remembered session and only announces itself.
  if (!state.sessionEnded) {
    state.target = await recall(host($),state.claudeSessionId);
    if (state.qualified && state.target) void autoConnect(state,$);
  }
  return next(event);
}
async function bind(state, $, requestedSessionId, options) {
  if (!state.qualified) {
    await qualifyConnection(state,$);
  }
  if (state.sessionEnded) return {text:TEXT.ended};
  const h = host($);
  const result = await state.owner.connect(h,requestedSessionId,options);
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
  // Give Claude its routing through the existing note; keep owner output plain.
  const {binding} = bound.result;
  const guidance = chosen === null ? '' : '\nThis resumes an earlier session: read reconnect.md in the ariadne skill first.';
  state.note = {binding,explicit:true,tries:0,sending:false};
  await deliverNote(state,$);
  const summary = 'This conversation is connected to Ariadne. File your work as you go; the ariadne skill has the rest.';
  return {text:summary + guidance};
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
  return {text:JSON.stringify({binding:await state.owner.status(host($)),local:state.loop?.status() ?? null})};
}
async function disconnectAction(state, $) {
  if (!state.qualified) await qualifyConnection(state,$);
  if (state.sessionEnded) return {text:TEXT.ended};
  const h = host($);
  // An explicit disconnect also cancels any automatic reconnect.
  state.target = null;
  state.note = null;
  state.notices.delete('auto');
  state.owner?.endBackground(h);
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
  try { if (state.loop) { await state.loop.start(host($),event); state.notices.good(host($),'helper'); } }
  catch (error) { failure(state,$,error); }
  return next(event);
}
async function turnComplete(state, $, event, next) {
  // A retired loop still records the end of a turn it delivered.
  try {
    const active = [state.loop,...state.retired].filter(Boolean);
    for (const loop of active) await loop.complete(host($),event);
    if (active.length) state.notices.good(host($),'helper');
  }
  catch (error) { failure(state,$,error); }
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
  state.owner?.endBackground(host($));
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
    // New routing the model has not been told yet (see routingNote).
    note: null,
    retired: [],
    following: null,
    notices: noticeEpisodes(),
    discovery: announcements(descriptor),
    owner: null,
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
