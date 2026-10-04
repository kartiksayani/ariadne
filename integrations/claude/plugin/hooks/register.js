import installed from './installed.js';
import { claimLoop } from './claims.js';
import { qualify, setup } from './setup.js';
import { ModError } from './contracts.js';

export function createRegister(descriptor) {
  return function register(on) {
    let timer = null;
    let loop = null;
    let qualified = false;
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
    on('command.run',{command:'ariadne-connect'},($) => checked($,async () => {
      if (!qualified) { await qualify($,descriptor); qualified = true;
        timer ??= $.clock.every(1000,() => { if (loop) void loop.poll($); }); }
      if (loop?.outstanding()) return {text:'Ariadne recovery_required: an original claim or lifecycle report is outstanding; recover it before reconnecting.'};
      const result = await owner.connect($);
      loop = claimLoop(descriptor.helperPath,result.binding);
      return {text:JSON.stringify(result)};
    }));
    on('command.run',{command:'ariadne-status'},($) => checked($,async () => {
      if (!qualified) await qualify($,descriptor);
      return {text:JSON.stringify({binding:await owner.status($),local:loop?.status() ?? null})};
    }));
    on('command.run',{command:'ariadne-disconnect'},($) => checked($,async () => {
      if (loop?.outstanding()) return {text:'Ariadne recovery_required: preserve the original claim/reports before disconnecting.'};
      if (!qualified) await qualify($,descriptor);
      if (loop) await loop.stop($);
      const receipt = await owner.disconnect($);
      loop = null;
      return {text:JSON.stringify(receipt)};
    }));
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
      timer?.cancel();
      if (loop) await loop.stop($,true);
      return next(event);
    });
  };
}
export const register = createRegister(installed);
