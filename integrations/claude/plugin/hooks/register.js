import installed from './installed.js';
import { claimLoop } from './claims.js';
import { qualify, setup } from './setup.js';
import { descriptorValid, ModError, uuid } from './contracts.js';
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
  };
}

function selectedSession(event) {
  if (typeof event?.args !== 'string' || event.args.length > 64) throw new ModError('Connect requires bounded SDK command arguments; use /ariadne-connect [session-id].');
  const argument = event.args.trim();
  if (argument === '') return null;
  if (!uuid(argument)) throw new ModError('Use /ariadne-connect followed by one canonical Ariadne session UUID.');
  return argument;
}

export function createRegister(descriptor) {
  return on => registerModule(descriptor, on);
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
async function heartbeat(state, $) {
  if (state.sessionEnded || state.ownerTransition) return;
  try { await state.discovery.announce(host($),state.announcementScope); }
  catch (error) { failure($,error); }
}
function pollLoop(state, $) {
  if (state.loop) void state.loop.poll(host($));
}
async function transition(state, $, action) {
  if (state.ownerTransition) return {text:'Ariadne owner operation is in progress; wait for its original receipt and retain operation IDs.'};
  if (state.sessionEnded) return {text:'The original Claude session ended; no new Ariadne owner operation was admitted.'};
  state.ownerTransition = true;
  try {
    if (state.loop) await state.loop.quiesce();
    if (state.sessionEnded) return {text:'The original Claude session ended; no new Ariadne owner operation was admitted.'};
    if (state.loop?.outstanding() || state.pending?.loop.outstanding()) return {text:'Ariadne recovery_required: an original claim or lifecycle report is outstanding; recover it before changing the binding.'};
    return await action();
  } finally { state.ownerTransition = false; }
}
async function savedBinding(state, h, binding) {
  state.announcementScope = {binding_id:binding.binding_id,generation:binding.generation};
  if (!state.pending || state.pending.binding.binding_id !== binding.binding_id || state.pending.binding.generation !== binding.generation) {
    if (state.pending?.loop.outstanding()) throw new ModError('Original saved-scope lifecycle evidence remains pending; recover it before changing the binding.');
    const sameScope = state.loopBinding?.binding_id === binding.binding_id && state.loopBinding?.generation === binding.generation;
    state.pending = {binding,loop:sameScope ? state.loop : claimLoop(state.descriptor.helperPath,binding)};
    // The saved scope owns lifecycle reporting before it owns claim admission.
    await state.pending.loop.quiesce();
  }
  if (state.sessionEnded) { await state.pending.loop.stop(h,true); return; }
  if (!await state.discovery.announce(h,state.announcementScope)) {
    throw new ModError('Bound announcement is pending or the original session ended; no claims were admitted.');
  }
}
async function sessionStart(state, $, event, next) {
  for (const [name,description] of [['ariadne-connect','Bind this original conversation to Ariadne'],['ariadne-status','Show the registered Ariadne connection'],['ariadne-disconnect','Disconnect Ariadne without stopping Claude']]) {
    await $.command.register({name,description,...(name === 'ariadne-connect' ? {argumentHint:'[session-id]'} : {})});
  }
  // Discovery may describe an unqualified engine; only native inspection can
  // qualify it. Its heartbeat never enables the independent claim loop.
  if (descriptorValid(state.descriptor,{name:$.plugin.name,root:$.plugin.root})) {
    state.announcementTimer = $.clock.every(30000,() => heartbeat(state,$));
    await heartbeat(state,$);
  }
  if (state.sessionEnded) return next(event);
  try {
    await qualify(host($),state.descriptor);
    state.qualified = true;
    if (!state.sessionEnded) state.timer = $.clock.every(1000,() => pollLoop(state,$));
  } catch (error) { failure($,error); }
  return next(event);
}
async function connectTransition(state, $, requestedSessionId) {
  if (!state.qualified) { await qualify(host($),state.descriptor); state.qualified = true;
    if (!state.sessionEnded) state.timer ??= $.clock.every(1000,() => pollLoop(state,$)); }
  if (state.sessionEnded) return {text:'The original Claude session ended; no new Ariadne owner operation was admitted.'};
  const result = await state.owner.connect(host($),requestedSessionId);
  if (state.loop?.outstanding() || state.pending?.loop.outstanding()) return {text:`Ariadne recovery_required: late original-scope evidence remains retained; no new claim loop was admitted. Owner receipt: ${JSON.stringify(result)}`};
  state.loop = state.sessionEnded ? state.pending.loop : claimLoop(state.descriptor.helperPath,result.binding);
  state.loopBinding = result.binding;
  state.pending = null;
  state.announcementScope = {binding_id:result.binding.binding_id,generation:result.binding.generation};
  if (state.sessionEnded) await state.loop.stop(host($),true);
  const guidance = requestedSessionId === null ? '' : `\nResume structured Ariadne context for project ${result.binding.session.project_id}, session ${result.binding.session.session_id}: read its topics, items, questions, answers and results; summarize completed work, remaining work and missing context; reuse existing items and respect cancelled work. This does not transfer the old host transcript or dispatch an input.`;
  return {text:JSON.stringify(result) + guidance};
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
  if (state.sessionEnded) return {text:'The original Claude session ended; no new Ariadne owner operation was admitted.'};
  if (state.loop) await state.loop.stop(host($));
  const receipt = await state.owner.disconnect(host($));
  if (state.loop?.outstanding() || state.pending?.loop.outstanding()) return {text:`Ariadne recovery_required: late original-scope evidence remains retained. Owner receipt: ${JSON.stringify(receipt)}`};
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
  try { if (state.loop) await state.loop.complete(host($),event); }
  catch (error) { failure($,error); }
  return next(event);
}
async function sessionEnd(state, $, event, next) {
  state.sessionEnded = true;
  state.timer?.cancel();
  state.announcementTimer?.cancel();
  state.discovery.stop();
  if (state.loop) await state.loop.stop(host($),true);
  if (state.pending && state.pending.loop !== state.loop) await state.pending.loop.stop(host($),true);
  return next(event);
}

function registerModule(descriptor, on) {
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
    discovery: announcements(descriptor),
    owner: null,
  };
  state.owner = descriptor ? setup(descriptor.helperPath,(h,binding) => savedBinding(state,h,binding)) : null;
  on('session.start',($,event,next) => sessionStart(state,$,event,next));
  on('command.run',{command:'ariadne-connect'},($,event) => connectRun(state,$,event));
  on('command.run',{command:'ariadne-status'},($) => checked($,() => statusAction(state,$)));
  on('command.run',{command:'ariadne-disconnect'},($) => checked($,() => transition(state,$,() => disconnectAction(state,$))));
  on('turn.start',($,event,next) => turnStart(state,$,event,next));
  on('turn.complete',($,event,next) => turnComplete(state,$,event,next));
  on('session.end',($,event,next) => sessionEnd(state,$,event,next));
}

export const register = on => registerModule(installed, on);
