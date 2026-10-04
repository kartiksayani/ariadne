import installed from './installed.js';
import { claimLoop } from './claims.js';
import { qualify, setup } from './setup.js';
import { descriptorValid, ModError, uuid } from './contracts.js';
import { announcements } from './discovery.js';

function selectedSession(event) {
  if (typeof event?.args !== 'string' || event.args.length > 64) throw new ModError('Connect requires bounded SDK command arguments; use /ariadne-connect [session-id].');
  const argument = event.args.trim();
  if (argument === '') return null;
  if (!uuid(argument)) throw new ModError('Use /ariadne-connect followed by one canonical Ariadne session UUID.');
  return argument;
}

export function createRegister(descriptor) {
  return function register(on) {
    let timer = null;
    let announcementTimer = null;
    let announcementScope = null;
    let loop = null;
    let qualified = false;
    let ownerTransition = false;
    let sessionEnded = false;
    const owner = descriptor ? setup(descriptor.helperPath) : null;
    const discovery = announcements(descriptor);
    function failure($, error) {
      // Only our bounded actionable messages are displayed; raw rejected host
      // promises, helper stderr and owner payloads are never reflected.
      $.ui.log(error instanceof ModError ? error.message : 'Ariadne helper unavailable; retain original IDs and check the app.');
    }
    async function checked($, action) {
      try { return await action(); }
      catch (error) { failure($,error); return {text:'Ariadne operation did not complete. See the local status message; retain original operation IDs.'}; }
    }
    async function heartbeat($) {
      if (sessionEnded || ownerTransition) return;
      try { await discovery.announce($,announcementScope); }
      catch (error) { failure($,error); }
    }
    async function transition($, action) {
      if (ownerTransition) return {text:'Ariadne owner operation is in progress; wait for its original receipt and retain operation IDs.'};
      if (sessionEnded) return {text:'The original Claude session ended; no new Ariadne owner operation was admitted.'};
      ownerTransition = true;
      try {
        if (loop) await loop.quiesce();
        if (sessionEnded) return {text:'The original Claude session ended; no new Ariadne owner operation was admitted.'};
        if (loop?.outstanding()) return {text:'Ariadne recovery_required: an original claim or lifecycle report is outstanding; recover it before changing the binding.'};
        return await action();
      } finally { ownerTransition = false; }
    }
    on('session.start',async ($,event,next) => {
      for (const [name,description] of [['ariadne-connect','Bind this original conversation to Ariadne'],['ariadne-status','Show the registered Ariadne connection'],['ariadne-disconnect','Disconnect Ariadne without stopping Claude']]) {
        await $.command.register({name,description,...(name === 'ariadne-connect' ? {argumentHint:'[session-id]'} : {})});
      }
      // Discovery may describe an unqualified engine; only native inspection can
      // qualify it. Its heartbeat never enables the independent claim loop.
      if (descriptorValid(descriptor,$.plugin)) {
        announcementTimer = $.clock.every(30000,() => heartbeat($));
        await heartbeat($);
      }
      if (sessionEnded) return next(event);
      try {
        await qualify($,descriptor);
        qualified = true;
        if (!sessionEnded) timer = $.clock.every(1000,() => { if (loop) void loop.poll($); });
      } catch (error) { failure($,error); }
      return next(event);
    });
    on('command.run',{command:'ariadne-connect'},($,event) => checked($,() => {
      const requestedSessionId = selectedSession(event);
      return transition($,async () => {
        if (!qualified) { await qualify($,descriptor); qualified = true;
          if (!sessionEnded) timer ??= $.clock.every(1000,() => { if (loop) void loop.poll($); }); }
        if (sessionEnded) return {text:'The original Claude session ended; no new Ariadne owner operation was admitted.'};
        const result = await owner.connect($,requestedSessionId);
        if (loop?.outstanding()) return {text:`Ariadne recovery_required: late original-scope evidence remains retained; no new claim loop was admitted. Owner receipt: ${JSON.stringify(result)}`};
        loop = claimLoop(descriptor.helperPath,result.binding);
        announcementScope = {binding_id:result.binding.binding_id,generation:result.binding.generation};
        if (sessionEnded) await loop.stop($,true);
        const guidance = requestedSessionId === null ? '' : `\nResume structured Ariadne context for project ${result.binding.session.project_id}, session ${result.binding.session.session_id}: read its topics, items, questions, answers and results; summarize completed work, remaining work and missing context; reuse existing items and respect cancelled work. This does not transfer the old host transcript or dispatch an input.`;
        return {text:JSON.stringify(result) + guidance};
      });
    }));
    on('command.run',{command:'ariadne-status'},($) => checked($,async () => {
      if (!qualified) await qualify($,descriptor);
      return {text:JSON.stringify({binding:await owner.status($),local:loop?.status() ?? null})};
    }));
    on('command.run',{command:'ariadne-disconnect'},($) => checked($,() => transition($,async () => {
      if (!qualified) await qualify($,descriptor);
      if (sessionEnded) return {text:'The original Claude session ended; no new Ariadne owner operation was admitted.'};
      if (loop) await loop.stop($);
      const receipt = await owner.disconnect($);
      if (loop?.outstanding()) return {text:`Ariadne recovery_required: late original-scope evidence remains retained. Owner receipt: ${JSON.stringify(receipt)}`};
      loop = null;
      announcementScope = null;
      return {text:JSON.stringify(receipt)};
    })));
    on('turn.start',async ($,event,next) => {
      try { if (loop) await loop.start($,event); }
      catch (error) { failure($,error); }
      return next(event);
    });
    on('turn.complete',async ($,event,next) => {
      try { if (loop) await loop.complete($,event); }
      catch (error) { failure($,error); }
      return next(event);
    });
    on('session.end',async ($,event,next) => {
      sessionEnded = true;
      timer?.cancel();
      announcementTimer?.cancel();
      discovery.stop();
      if (loop) await loop.stop($,true);
      return next(event);
    });
  };
}
export const register = createRegister(installed);
