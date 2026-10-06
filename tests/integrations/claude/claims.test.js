import { describe, it, expect } from 'vitest';
import { claimLoop } from '../../../integrations/claude/plugin/hooks/claims.js';
import { binding, deferred, descriptor, failure, host, ids, prepared, success } from './fixtures.js';

describe('captured Claude claim lifecycle', () => {
  it('detaches submission, matches exact first-line marker+full digest, ignores unrelated/subagent turns', async () => {
    const value = await prepared(); const submission = deferred();
    const h = host({claim:value,submit:() => submission.promise});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);
    expect(h.prompts).toEqual([{text:value.formatted_payload,asUser:true}]);
    await loop.start(h.$,{text:'prefix'+value.formatted_payload,turnId:'unrelated'});
    await loop.start(h.$,{text:value.formatted_payload+' ',turnId:'changed'});
    expect(h.events).toEqual([]);
    await loop.start(h.$,{text:value.formatted_payload,turnId:'actual-turn'});
    await loop.complete(h.$,{turnId:'actual-turn',agentId:'child',answer:'subagent',reason:'answer',isAborted:false});
    await loop.complete(h.$,{turnId:'other-turn',answer:'unrelated',reason:'answer',isAborted:false});
    expect(h.events.map(event => event.kind)).toEqual(['accepted','turn_started']);
    await loop.complete(h.$,{turnId:'actual-turn',answer:'Visible final only',reason:'answer',isAborted:false});
    expect(h.events.at(-1).payload).toEqual({status:'completed',reason:'answer',diagnostic_text:'Visible final only',truncated:false});
    expect(loop.outstanding()).toBe(true); // Detached submission still unsettled.
    submission.resolve({text:value.formatted_payload});
    await loop.stop(h.$);
  });
  const frames = {
    between:payload => `The ariadne plugin sent a message:\n${payload}\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.`,
    mid:payload => `The ariadne plugin sent a message while you were working:\n${payload}\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.`,
  };
  for (const [name,frame] of Object.entries(frames)) {
    it(`correlates a host-framed turn.start (${name}) and finishes the turn`, async () => {
      const value = await prepared(); const h = host({claim:value});
      const loop = claimLoop(descriptor.helperPath,binding);
      await loop.poll(h.$);await h.reported('accepted');
      await loop.start(h.$,{text:frame(value.formatted_payload),turnId:'framed-turn'});
      expect(loop.status().active.host_turn_id).toBe('framed-turn');
      expect(h.events.map(event => event.kind)).toContain('turn_started');
      await loop.complete(h.$,{turnId:'framed-turn',answer:'done',reason:'answer',isAborted:false});
      expect(h.events.at(-1).kind).toBe('turn_finished');
      expect(h.events.at(-1).payload.status).toBe('completed');
      expect(loop.status().active).toBe(null);
    });
  }
  it('does not correlate a framed turn.start with an altered payload or a mid-line marker', async () => {
    const value = await prepared(); const h = host({claim:value});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);await h.reported('accepted');
    await loop.start(h.$,{text:frames.between(value.formatted_payload.slice(0,-1)+'X'),turnId:'altered'});
    await loop.start(h.$,{text:`Sent: ${value.formatted_payload}\nrest`,turnId:'midline'});
    await loop.start(h.$,{text:frames.between(value.formatted_payload+'extra'),turnId:'suffix'});
    expect(loop.status().active.host_turn_id).toBe(null);
    expect(h.events.map(event => event.kind)).toEqual(['accepted']);
  });
  it('logs the observed turn.start form exactly once across two correlated claims', async () => {
    const value = await prepared(); const h = host({claim:value});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);await h.reported('accepted');
    await loop.start(h.$,{text:frames.between(value.formatted_payload),turnId:'t1'});
    await loop.complete(h.$,{turnId:'t1',answer:'a',reason:'answer',isAborted:false});
    await loop.poll(h.$);
    await loop.start(h.$,{text:value.formatted_payload,turnId:'t2'});
    const evidence = h.logs.filter(text => text.startsWith('Ariadne: turn.start carried'));
    expect(evidence).toEqual([`Ariadne: turn.start carried the framed payload (${frames.between(value.formatted_payload).length} chars).`]);
    expect(loop.status().active.host_turn_id).toBe('t2');
  });
  it('accepts an exact submission result before start without producing another prompt or acceptance', async () => {
    const value = await prepared(); const h = host({claim:value});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);await h.reported('accepted');
    await loop.start(h.$,{text:value.formatted_payload,turnId:'turn'});
    await loop.poll(h.$);
    expect(h.events.filter(event => event.kind === 'accepted')).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);
    expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(1);
  });
  it('retains claim request UUID on helper uncertainty and never submits until canonical proof arrives', async () => {
    const value = await prepared();let fail = true;
    const h = host({claim:value,handler:argv => argv[2] === 'claim' && fail ? failure() : undefined});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);expect(h.prompts).toHaveLength(0);
    fail = false;await loop.poll(h.$);
    const claims = h.calls.filter(call => call.argv[2] === 'claim');
    expect(claims[0].argv.at(-1)).toBe(claims[1].argv.at(-1));
    expect(h.prompts).toHaveLength(1);
    await h.reported('accepted');
  });
  it('logs an owner-paused claim block once, keeps polling, and never pauses or submits', async () => {
    const h = host({handler:argv => argv[2] === 'claim' ? failure('invalid_transition',{reason:'owner_paused'}) : undefined});
    const loop = claimLoop(descriptor.helperPath,binding);
    for (let index=0;index<3;index++) await loop.poll(h.$);
    expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(3);
    expect(h.logs).toEqual(['Ariadne paused: Dispatch is withheld by the app (owner_paused); claims resume when the owner resumes or recovers.']);
    expect(loop.status().paused).toBe(false);
    expect(h.prompts).toHaveLength(0);
  });
  it('logs a blocked claim again after an empty queue resets the reason', async () => {
    let mode = 'blocked';
    const h = host({handler:argv => argv[2] === 'claim' && mode === 'blocked' ? failure('invalid_transition',{reason:'owner_paused'}) : undefined});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);await loop.poll(h.$);
    mode = 'empty';await loop.poll(h.$);
    mode = 'blocked';await loop.poll(h.$);await loop.poll(h.$);
    expect(h.logs).toHaveLength(2);
    expect(h.logs.every(text => text.includes('(owner_paused)'))).toBe(true);
  });
  it('logs a repeated claim failure once across polls', async () => {
    const h = host({handler:argv => argv[2] === 'claim' ? failure('host_unreachable') : undefined});
    const loop = claimLoop(descriptor.helperPath,binding);
    for (let index=0;index<3;index++) await loop.poll(h.$);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain('Claim/report helper failed');
  });
  it('logs a claim failure again after an empty queue resets it', async () => {
    let mode = 'down';
    const h = host({handler:argv => argv[2] === 'claim' && mode === 'down' ? failure('host_unreachable') : undefined});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);await loop.poll(h.$);
    mode = 'empty';await loop.poll(h.$);
    mode = 'down';await loop.poll(h.$);await loop.poll(h.$);
    expect(h.logs).toHaveLength(2);
  });
  it('logs each time the claim failure code changes', async () => {
    let code = 'host_unreachable';
    const h = host({handler:argv => argv[2] === 'claim' ? failure(code) : undefined});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);await loop.poll(h.$);
    code = 'not_found';await loop.poll(h.$);await loop.poll(h.$);
    expect(h.logs).toHaveLength(2);
  });
  it('serializes concurrent poll callbacks and retains lifecycle exactly across desktop/helper failure', async () => {
    const value = await prepared();const response = deferred();const admitted = deferred();const submission = deferred();let failing = true;
    const attempts = [];
    const h = host({claim:value,submit:() => submission.promise,handler:async (argv,options) => {
      if (argv[2] === 'claim') {admitted.resolve();return response.promise;}
      if (argv[2] === 'report') {attempts.push(options.stdin);if (failing) return failure();}
    }});
    const loop = claimLoop(descriptor.helperPath,binding);
    const first = loop.poll(h.$);await admitted.promise;await loop.poll(h.$);
    expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(1);
    response.resolve(success(value));await first;
    await loop.start(h.$,{text:value.formatted_payload,turnId:'turn'});
    expect(loop.status().pending_reports).toBe(2);
    expect(h.prompts).toHaveLength(1);
    failing = false;await loop.poll(h.$);
    expect(attempts[0]).toBe(attempts[1]);
    expect(attempts[0]).toBe(attempts[2]);
    expect(loop.status().pending_reports).toBe(0);
    expect(h.events.map(event => event.kind)).toEqual(['accepted','turn_started']);
    submission.resolve({text:value.formatted_payload});await loop.stop(h.$);
  });
  it('records an early drop as rejection and a drop after verified start as uncertain on the captured original scope', async () => {
    const value = await prepared();
    for (const started of [false,true]) {
      const submission = deferred();const h = host({claim:value,submit:() => submission.promise});
      const loop = claimLoop(descriptor.helperPath,binding);
      await loop.poll(h.$);
      if (started) await loop.start(h.$,{text:value.formatted_payload,turnId:'original-turn'});
      submission.resolve({drop:'raw provider detail should not escape'});
      const event = await h.reported(started ? 'uncertain' : 'rejected');
      expect(event.binding_id).toBe(ids.binding);expect(event.generation).toBe(ids.generation);
      expect(event.attempt_id).toBe(ids.attempt);
      expect(JSON.stringify(event)).not.toContain('raw provider detail');
      await loop.poll(h.$);expect(h.prompts).toHaveLength(1);expect(loop.status().paused).toBe(true);
    }
  });
  it('maps interrupted/refused/API-error evidence conservatively, bounds diagnostics, and rejects unknown terminal reasons', async () => {
    const value = await prepared();
    for (const [reason,isAborted,expected] of [['aborted',true,'interrupted'],['refusal',false,'failed'],['error',false,'failed'],['answer',true,'interrupted'],['future',false,null]]) {
      const submission = deferred();const h = host({claim:value,submit:() => submission.promise});
      const loop = claimLoop(descriptor.helperPath,binding);await loop.poll(h.$);
      await loop.start(h.$,{text:value.formatted_payload,turnId:'turn'});
      await loop.complete(h.$,{turnId:'turn',answer:'😀'.repeat(20000),reason,isAborted});
      const terminal = h.events.at(-1);
      expect(terminal.kind).toBe(expected ? 'turn_finished' : 'uncertain');
      if (expected) {expect(terminal.payload.status).toBe(expected);expect(terminal.payload.truncated).toBe(true);}
      submission.resolve({text:value.formatted_payload});await loop.stop(h.$);
    }
  });
  it('session switch stops new work and a post-claim switch creates uncertainty without submitting', async () => {
    const value = await prepared();
    const h = host({claim:value});const loop = claimLoop(descriptor.helperPath,binding);
    h.switchSession('different');await loop.poll(h.$);
    expect(h.calls).toEqual([]);expect(loop.status().paused).toBe(true);
    const changed = host({claim:value,handler:argv => {if (argv[2] === 'claim') changed.switchSession('different');}});
    const other = claimLoop(descriptor.helperPath,binding);await other.poll(changed.$);
    expect(changed.prompts).toEqual([]);expect(changed.events.at(-1).kind).toBe('uncertain');
  });
  it('accepts valid unchanged lifecycle facts without writes while retaining a detached submission fence', async () => {
    const value = await prepared();const submission = deferred();const observed = [];
    const h = host({claim:value,submit:() => submission.promise,handler:(argv,options) => {
      if (argv[2] === 'report') {
        const event = JSON.parse(options.stdin);observed.push(event.kind);
        return success({event_id:event.event_id,session_id:ids.session,revision:null,durable_effect:false,replayed:false});
      }
    }});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);
    await loop.start(h.$,{text:value.formatted_payload,turnId:'turn'});
    await loop.complete(h.$,{turnId:'turn',answer:'answer',reason:'answer',isAborted:false});
    expect(observed).toEqual(['accepted','turn_started','turn_finished']);
    expect(loop.status().pending_reports).toBe(0);
    expect(loop.status().active).toBe(null);
    expect(loop.outstanding()).toBe(true);
    expect(h.prompts).toHaveLength(1);
    submission.resolve({text:value.formatted_payload});
    await loop.stop(h.$,true);
    expect(observed.at(-1)).toBe('disconnected');
    expect(loop.status().pending_reports).toBe(0);
    await expect.poll(() => loop.outstanding(), { timeout:1000 }).toBe(false);
  });
  it('keeps a terminal pending after a mismatched receipt and retries identical bytes before another claim', async () => {
    const value = await prepared();const submission = deferred();let corrupt = true;const terminalBytes = [];
    const h = host({claim:value,submit:() => submission.promise,handler:(argv,options) => {
      if (argv[2] === 'report' && JSON.parse(options.stdin).kind === 'turn_finished') {
        terminalBytes.push(options.stdin);
        if (corrupt) return success({event_id:'other',session_id:ids.session,revision:null,durable_effect:false,replayed:false});
      }
    }});
    const loop = claimLoop(descriptor.helperPath,binding);await loop.poll(h.$);
    await loop.start(h.$,{text:value.formatted_payload,turnId:'turn'});
    await loop.complete(h.$,{turnId:'turn',answer:'answer',reason:'answer',isAborted:false});
    expect(loop.status().active).not.toBe(null);
    corrupt = false;await loop.poll(h.$);
    expect(terminalBytes).toHaveLength(2);expect(terminalBytes[0]).toBe(terminalBytes[1]);
    // Outstanding detached promise still fences reconnect even after terminal ack.
    expect(loop.outstanding()).toBe(true);
    submission.resolve({text:value.formatted_payload});await loop.stop(h.$);
  });
  it('stops polling and reports Disconnected best effort at session end without cancelling an external host', async () => {
    const h = host();const loop = claimLoop(descriptor.helperPath,binding);
    await loop.stop(h.$,true);await loop.stop(h.$,true);await loop.poll(h.$);
    expect(h.events.map(event => event.kind)).toEqual(['disconnected']);
    expect(h.events[0].input_id).toBe(null);expect(h.prompts).toEqual([]);
    expect(h.calls.every(call => call.argv[2] === 'report')).toBe(true);
  });
  it('coalesces duplicate terminal floods, preserves first contradiction and one explicit unsupported gap without dropping unsaved originals', async () => {
    const value = await prepared();const submission = deferred();let failTerminal = true;const attempts = [];
    const h = host({claim:value,submit:() => submission.promise,handler:(argv,options) => {
      if (argv[2] === 'report' && JSON.parse(options.stdin).kind === 'turn_finished') {
        attempts.push(JSON.parse(options.stdin));if (failTerminal) return failure('protocol_conflict');
      }
    }});
    const loop = claimLoop(descriptor.helperPath,binding);await loop.poll(h.$);
    await loop.start(h.$,{text:value.formatted_payload,turnId:'turn'});
    const first = {turnId:'turn',answer:'original',reason:'answer',isAborted:false};
    await loop.complete(h.$,first);
    for (let index=0;index<300;index++) await loop.complete(h.$,{...first});
    expect(loop.status().pending_reports).toBe(1);
    await loop.complete(h.$,{...first,answer:'first conflicting snapshot'});
    expect(loop.status().pending_reports).toBe(2);expect(loop.status().paused).toBe(true);
    await loop.complete(h.$,{...first,answer:'third distinct snapshot'});
    for (let index=0;index<300;index++) await loop.complete(h.$,{...first,answer:`unsupported revision ${index}`});
    expect(loop.status().pending_reports).toBe(3);
    expect(loop.status().unsupported_terminal_revisions).toBe(true);
    failTerminal = false;await loop.poll(h.$);
    const terminal = h.events.filter(event => event.kind === 'turn_finished');
    expect(terminal.map(event => event.payload.diagnostic_text)).toEqual(['original','first conflicting snapshot']);
    expect(terminal[0].event_id).toBe(terminal[1].event_id);
    expect(h.events.at(-1).payload.reason).toContain('additional raw callbacks were not persisted');
    expect(attempts[0]).toEqual(terminal[0]);
    expect(h.prompts).toHaveLength(1);
    submission.resolve({text:value.formatted_payload});await loop.stop(h.$);
  });
});
