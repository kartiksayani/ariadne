import installed from './installed.js';
import { claimLoop } from './claims.js';
import { qualify, setup } from './setup.js';
import { ModError } from './contracts.js';

export function createRegister(descriptor) {
  return function register(on) {
    let timer = null;
    let loop = null;
    let qualified = false;
    let ownerTransition = false;
    let sessionEnded = false;
    const owner = descriptor ? setup(descriptor.helperPath) : null;
    function failure($, error) {
      // Only our bounded actionable messages are displayed; raw rejected host
      // promises, helper stderr and owner payloads are never reflected.
      $.ui.log(error instanceof ModError ? error.message : 'Ariadne helper unavailable; retain original IDs and check the app.');
    }
    async function checked($, action) {
      try { return await action(); }
      catch (error) { failure($,error); return {text:'Ariadne operation did not complete. See the local status message; retain original operation IDs.'}; }
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
        await $.command.register({name,description});
      }
      try {
        await qualify($,descriptor);
        qualified = true;
        timer = $.clock.every(1000,() => { if (loop) void loop.poll($); });
      } catch (error) { failure($,error); }
      return next(event);
    });
    on('command.run',{command:'ariadne-connect'},($) => checked($,() => transition($,async () => {
      if (!qualified) { await qualify($,descriptor); qualified = true;
        timer ??= $.clock.every(1000,() => { if (loop) void loop.poll($); }); }
      if (sessionEnded) return {text:'The original Claude session ended; no new Ariadne owner operation was admitted.'};
      const result = await owner.connect($);
      if (loop?.outstanding()) return {text:`Ariadne recovery_required: late original-scope evidence remains retained; no new claim loop was admitted. Owner receipt: ${JSON.stringify(result)}`};
      loop = claimLoop(descriptor.helperPath,result.binding);
      if (sessionEnded) await loop.stop($,true);
      return {text:JSON.stringify(result)};
    })));
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
      if (loop) await loop.stop($,true);
      return next(event);
    });
  };
}
export const register = createRegister(installed);
