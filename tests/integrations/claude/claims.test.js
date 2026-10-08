import { describe, it, expect } from 'vitest';
import { FOLD_GRACE_MS, NOTICES, claimLoop } from '../../../integrations/claude/plugin/hooks/claims.js';
import { hash } from '../../../integrations/claude/plugin/hooks/contracts.js';
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
  it('logs an owner-paused claim block once in plain words, keeps polling, and never submits', async () => {
    const h = host({handler:argv => argv[2] === 'claim' ? failure('invalid_transition',{reason:'owner_paused'}) : undefined});
    const loop = claimLoop(descriptor.helperPath,binding);
    for (let index=0;index<3;index++) await loop.poll(h.$);
    expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(3);
    expect(h.logs).toEqual([NOTICES.owner_paused]);
    expect(h.logs.join('')).not.toMatch(/owner_paused|needs_attention|generation/);
    expect(loop.status().admission_open).toBe(true);
    expect(h.prompts).toHaveLength(0);
  });
  it('logs a closed session once and keeps asking so dispatch resumes after reopen', async () => {
    let closed = true;
    const value = await prepared();
    const h = host({claim:value,handler:argv => argv[2] === 'claim' && closed ? failure('invalid_transition',{reason:'session_closed'}) : undefined});
    const loop = claimLoop(descriptor.helperPath,binding);
    for (let index=0;index<3;index++) await loop.poll(h.$);
    expect(h.logs).toEqual([NOTICES.session_closed]);
    closed = false;await loop.poll(h.$);
    expect(h.prompts).toEqual([{text:value.formatted_payload,asUser:true}]);
  });
  it('logs the generic blocked form for an unexpected invalid_transition reason, never the raw string', async () => {
    const h = host({handler:argv => argv[2] === 'claim' ? failure('invalid_transition',{reason:'evil\nreason $(x)'}) : undefined});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);
    expect(h.logs).toEqual([NOTICES.blocked]);
    expect(h.logs.join('')).not.toContain('evil');
  });
  it('keeps a claim request ID the app may have saved while it holds no lease, and retries it quietly', async () => {
    const value = await prepared();let mode = 'lost';
    const h = host({claim:value,handler:argv => {
      if (argv[2] !== 'claim') return undefined;
      if (mode === 'lost') {mode = 'unleased';return failure('delivery_uncertain');}
      if (mode === 'unleased') return failure('not_found',{reason:'lease_invalid'});
    }});
    const removed = [];
    const loop = claimLoop(descriptor.helperPath,binding,{onEnded:() => removed.push(true)});
    for (let index=0;index<3;index++) await loop.poll(h.$);
    expect(h.logs).toEqual([NOTICES.failure]);expect(removed).toEqual([]);
    expect(loop.busy()).toBe('claim');
    mode = 'leased';await loop.poll(h.$);
    const claims = h.calls.filter(call => call.argv[2] === 'claim').map(call => call.argv.at(-1));
    expect(new Set(claims).size).toBe(1);expect(claims).toHaveLength(4);
    expect(h.prompts).toHaveLength(1);
  });
  for (const [name,refusal] of [['holds no lease',() => failure('not_found',{reason:'lease_invalid'})],
    ['has the session paused',() => failure('invalid_transition',{reason:'owner_paused'})],
    ['has the session closed',() => failure('invalid_transition',{reason:'session_closed'})]]) {
    it(`does not hold commands up on a claim the app refused before saving it, while it ${name}`, async () => {
      const h = host({handler:argv => argv[2] === 'claim' ? refusal() : undefined});
      const loop = claimLoop(descriptor.helperPath,binding);
      await loop.poll(h.$);await loop.poll(h.$);
      expect(loop.busy()).toBe(null);expect(loop.outstanding()).toBe(false);
      expect(loop.status().pending_claim_request_id).toBe(null);
      // Nothing to confirm, so an owner command makes no claim of its own.
      await loop.settle(h.$);
      const claims = h.calls.filter(call => call.argv[2] === 'claim').map(call => call.argv.at(-1));
      expect(claims).toHaveLength(2);expect(new Set(claims).size).toBe(2);
      expect(h.prompts).toEqual([]);
    });
  }
  it('drops an unconfirmed claim request ID once the app refuses it as paused: the app replays a saved claim before it checks the pause', async () => {
    let mode = 'lost';
    const h = host({handler:argv => argv[2] === 'claim' ? (mode === 'lost' ? failure('delivery_uncertain') : failure('invalid_transition',{reason:'owner_paused'})) : undefined});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);
    expect(loop.busy()).toBe('claim');
    mode = 'paused';await loop.poll(h.$);
    expect(loop.busy()).toBe(null);
    const claims = h.calls.filter(call => call.argv[2] === 'claim').map(call => call.argv.at(-1));
    expect(claims[1]).toBe(claims[0]);
  });
  for (const [name,refusal] of [['removed session',() => failure('not_found',{reason:'session_removed'})],['replaced connection',() => failure('stale_generation')]]) {
    it(`stops for good and says so once when the claim finds a ${name}`, async () => {
      const h = host({handler:argv => argv[2] === 'claim' ? refusal() : undefined});
      const ended = [];
      const loop = claimLoop(descriptor.helperPath,binding,{onEnded:() => ended.push(true)});
      for (let index=0;index<3;index++) await loop.poll(h.$);
      expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(1);
      expect(h.logs).toEqual([NOTICES.removed]);
      expect(NOTICES.removed).toBe('This session was removed from Ariadne (or connected elsewhere). Run /ariadne-connect to connect again.');
      expect(ended).toEqual([true]);
      expect(loop.status()).toMatchObject({stopped:true,ended:true,admission_open:false});
      expect(loop.busy()).toBe(null);
    });
  }
  it('stops once when a lifecycle report finds the binding replaced, dropping evidence that has nowhere to go', async () => {
    const value = await prepared();
    const h = host({claim:value,handler:argv => argv[2] === 'report' ? failure('stale_generation') : undefined});
    const ended = [];
    const loop = claimLoop(descriptor.helperPath,binding,{onEnded:() => ended.push(true)});
    await loop.poll(h.$);
    await expect.poll(() => ended.length).toBe(1);
    await loop.poll(h.$);await loop.poll(h.$);
    expect(h.logs).toEqual([NOTICES.removed]);
    expect(loop.status().pending_reports).toBe(0);
    expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(1);
  });
  it('does not announce removal for a loop that was already stopped', async () => {
    const h = host({handler:argv => argv[2] === 'report' ? failure('stale_generation') : undefined});
    const ended = [];
    const loop = claimLoop(descriptor.helperPath,binding,{onEnded:() => ended.push(true)});
    await loop.stop(h.$,true);
    expect(h.logs).toEqual([]);expect(ended).toEqual([]);
    expect(await loop.drain(h.$)).toBe(true);
  });
  it('logs a malformed claim once across three polls', async () => {
    const h = host({handler:argv => argv[2] === 'claim' ? success({input_id:'not-a-claim'}) : undefined});
    const loop = claimLoop(descriptor.helperPath,binding);
    for (let index=0;index<3;index++) await loop.poll(h.$);
    expect(h.logs).toHaveLength(1);
    expect(h.prompts).toHaveLength(0);
  });
  it('correlates a framed turn.start when the marker also appears mid-line before the payload line', async () => {
    const value = await prepared(); const h = host({claim:value});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);await h.reported('accepted');
    await loop.start(h.$,{text:`Note: ${value.wire_marker} is quoted here\n${value.formatted_payload}\nrest`,turnId:'later'});
    expect(loop.status().active.host_turn_id).toBe('later');
  });
  it('logs a blocked claim again after an empty queue resets the reason', async () => {
    let mode = 'blocked';
    const h = host({handler:argv => argv[2] === 'claim' && mode === 'blocked' ? failure('invalid_transition',{reason:'owner_paused'}) : undefined});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);await loop.poll(h.$);
    mode = 'empty';await loop.poll(h.$);
    mode = 'blocked';await loop.poll(h.$);await loop.poll(h.$);
    expect(h.logs).toEqual([NOTICES.owner_paused,NOTICES.owner_paused]);
  });
  it('logs a repeated claim failure once across polls', async () => {
    const h = host({handler:argv => argv[2] === 'claim' ? failure('host_unreachable') : undefined});
    const loop = claimLoop(descriptor.helperPath,binding);
    for (let index=0;index<3;index++) await loop.poll(h.$);
    expect(h.logs).toEqual([NOTICES.failure]);
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
  it('logs one failure notice while the claim keeps failing, whatever the error code', async () => {
    let code = 'host_unreachable';
    const h = host({handler:argv => argv[2] === 'claim' ? failure(code) : undefined});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);await loop.poll(h.$);
    code = 'not_found';await loop.poll(h.$);await loop.poll(h.$);
    expect(h.logs).toEqual([NOTICES.failure]);
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
  it('records an early drop as rejection and a drop after verified start as uncertain, then hands the queue back to the app', async () => {
    const value = await prepared();
    for (const started of [false,true]) {
      const submission = deferred();let claims = 0;
      // The app decides what comes next; here it has nothing more to send.
      const h = host({claim:value,submit:() => submission.promise,handler:argv => argv[2] === 'claim' && ++claims > 1 ? success(null) : undefined});
      const loop = claimLoop(descriptor.helperPath,binding);
      await loop.poll(h.$);
      if (started) await loop.start(h.$,{text:value.formatted_payload,turnId:'original-turn'});
      submission.resolve({drop:'raw provider detail should not escape'});
      const event = await h.reported(started ? 'uncertain' : 'rejected');
      expect(event.binding_id).toBe(ids.binding);expect(event.generation).toBe(ids.generation);
      expect(event.attempt_id).toBe(ids.attempt);
      expect(JSON.stringify(event)).not.toContain('raw provider detail');
      await expect.poll(() => loop.busy()).toBe(null);
      await loop.poll(h.$);
      expect(h.prompts).toHaveLength(1);expect(claims).toBe(2);
      expect(loop.status().active).toBe(null);
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
  it('session switch holds new work without claiming, and a post-claim switch creates uncertainty without submitting', async () => {
    const value = await prepared();
    const h = host({claim:value});const loop = claimLoop(descriptor.helperPath,binding);
    h.switchSession('different');await loop.poll(h.$);await loop.poll(h.$);
    expect(h.calls).toEqual([]);expect(h.logs).toEqual([]);
    h.switchSession(binding.external_session_id);await loop.poll(h.$);
    expect(h.prompts).toEqual([{text:value.formatted_payload,asUser:true}]);
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
    expect(loop.status().pending_reports).toBe(2);
    // Unsaved evidence goes first: no claim overtakes it.
    await loop.poll(h.$);
    expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(1);
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
  it('finishes a message Claude folded into the running turn once the next turn starts without it, then claims the next one', async () => {
    // Claude takes a prompt submitted mid-turn into that turn: no turn.start carries it.
    const value = await prepared();let claims = 0;
    const h = host({claim:value,handler:argv => argv[2] === 'claim' && ++claims > 1 ? success(null) : undefined});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.start(h.$,{text:'Owner typed this in Claude',turnId:'running-turn'});
    await loop.poll(h.$);await h.reported('accepted');
    expect(loop.busy()).toBe('answering');
    await loop.complete(h.$,{turnId:'running-turn',agentId:'child',answer:'subagent',reason:'answer',isAborted:false});
    await loop.complete(h.$,{turnId:'running-turn',answer:'Answered both',reason:'answer',isAborted:false});
    // Not yet: Claude may still run the message as its own next turn.
    expect(h.events.map(event => event.kind)).toEqual(['accepted']);
    expect(loop.busy()).toBe('answering');
    await loop.start(h.$,{text:'Owner typed something else',turnId:'later-turn'});
    expect(h.events.map(event => event.kind)).toEqual(['accepted','turn_started','turn_finished']);
    expect(h.events.slice(1).every(event => event.host_turn_id === 'running-turn')).toBe(true);
    expect(h.events.at(-1).payload).toMatchObject({status:'completed',diagnostic_text:'Answered both'});
    expect(loop.status().active).toBe(null);expect(loop.busy()).toBe(null);
    await loop.poll(h.$);expect(claims).toBe(2);
  });
  it('finishes a folded message after the grace period when no next turn starts, keeping its first terminal callback', async () => {
    const value = await prepared();const clock = {now:1000};let claims = 0;
    const h = host({claim:value,handler:argv => argv[2] === 'claim' && ++claims > 1 ? success(null) : undefined});
    const loop = claimLoop(descriptor.helperPath,binding,{now:() => clock.now});
    await loop.start(h.$,{text:'Owner typed this in Claude',turnId:'running-turn'});
    await loop.poll(h.$);await h.reported('accepted');
    const end ={turnId:'running-turn',answer:'Answered both',reason:'answer',isAborted:false};
    await loop.complete(h.$,end);await loop.complete(h.$,{...end});
    clock.now += FOLD_GRACE_MS - 1;await loop.poll(h.$);
    expect(h.events.map(event => event.kind)).toEqual(['accepted']);
    clock.now += 1;await loop.poll(h.$);
    expect(h.events.map(event => [event.kind,event.host_turn_id])).toEqual([['accepted',null],['turn_started','running-turn'],['turn_finished','running-turn']]);
    expect(loop.busy()).toBe(null);
  });
  it('attributes a mid-turn message to the next turn that carries it, not to the turn that was running', async () => {
    // Claude may instead run a prompt submitted mid-turn as its own next turn.
    const value = await prepared();const clock = {now:1000};
    const h = host({claim:value});
    const loop = claimLoop(descriptor.helperPath,binding,{now:() => clock.now});
    await loop.start(h.$,{text:'Owner typed this in Claude',turnId:'first-turn'});
    await loop.poll(h.$);await h.reported('accepted');
    await loop.complete(h.$,{turnId:'first-turn',answer:'Answer to the owner prompt only',reason:'answer',isAborted:false});
    await loop.start(h.$,{text:value.formatted_payload,turnId:'message-turn'});
    clock.now += FOLD_GRACE_MS;await loop.poll(h.$);
    await loop.complete(h.$,{turnId:'message-turn',answer:'Answer to the message',reason:'answer',isAborted:false});
    expect(h.events.map(event => [event.kind,event.host_turn_id])).toEqual([['accepted',null],['turn_started','message-turn'],['turn_finished','message-turn']]);
    expect(h.events.at(-1).payload.diagnostic_text).toBe('Answer to the message');
  });
  it('finishes a folded message in a turn whose start this loop never saw', async () => {
    const value = await prepared();const clock = {now:0};
    const h = host({claim:value});
    const loop = claimLoop(descriptor.helperPath,binding,{now:() => clock.now});
    await loop.poll(h.$);await h.reported('accepted');
    await loop.complete(h.$,{turnId:'turn-before-connect',answer:'done',reason:'answer',isAborted:false});
    clock.now = FOLD_GRACE_MS;await loop.poll(h.$);
    expect(h.events.map(event => [event.kind,event.host_turn_id])).toEqual([['accepted',null],['turn_started','turn-before-connect'],['turn_finished','turn-before-connect']]);
  });
  it('reports a message accepted but never seen starting as uncertain when the loop stops, and never folds a later turn into it', async () => {
    const value = await prepared();
    const h = host({claim:value});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.start(h.$,{text:'Owner prompt',turnId:'running-turn'});
    await loop.poll(h.$);await h.reported('accepted');
    await loop.stop(h.$,true);
    expect(h.events.map(event => event.kind)).toEqual(['accepted','uncertain','disconnected']);
    expect(h.events[1]).toMatchObject({attempt_id:ids.attempt,host_turn_id:null});
    // The next conversation's turns reach a retired loop; none may finish the message.
    await loop.complete(h.$,{turnId:'running-turn',answer:'old turn',reason:'answer',isAborted:false});
    await loop.complete(h.$,{turnId:'next-conversation-turn',answer:'new conversation answer',reason:'answer',isAborted:false});
    expect(h.events.map(event => event.kind)).toEqual(['accepted','uncertain','disconnected']);
    expect(loop.busy()).toBe(null);
  });
  it('reports a pending fold uncertain when the loop stops inside the grace period: the message may never have run', async () => {
    const value = await prepared();const clock = {now:1000};
    const h = host({claim:value});
    const loop = claimLoop(descriptor.helperPath,binding,{now:() => clock.now});
    await loop.start(h.$,{text:'Owner typed this in Claude',turnId:'running-turn'});
    await loop.poll(h.$);await h.reported('accepted');
    await loop.complete(h.$,{turnId:'running-turn',answer:'Answered both',reason:'answer',isAborted:false});
    expect(h.events.map(event => event.kind)).toEqual(['accepted']);
    clock.now += FOLD_GRACE_MS - 1;
    await loop.stop(h.$,true);
    // No carrying turn was seen and the grace period had not run out: the owner gets the check-or-resend path, never "completed".
    expect(h.events.map(event => event.kind)).toEqual(['accepted','uncertain','disconnected']);
    expect(h.events[1]).toMatchObject({attempt_id:ids.attempt,host_turn_id:null});
    expect(h.events.some(event => event.kind === 'turn_started' || event.kind === 'turn_finished')).toBe(false);
    expect(loop.busy()).toBe(null);
    // The retired loop still never folds a later turn.
    await loop.complete(h.$,{turnId:'next-conversation-turn',answer:'new',reason:'answer',isAborted:false});
    expect(h.events).toHaveLength(3);
  });
  it('a stopped loop whose uncertain report did not save never folds, and sees no later turn', async () => {
    const value = await prepared();const clock = {now:1000};let failing = false;
    const h = host({claim:value,handler:argv => argv[2] === 'report' && failing ? failure() : undefined});
    const loop = claimLoop(descriptor.helperPath,binding,{now:() => clock.now});
    await loop.start(h.$,{text:'Owner typed this in Claude',turnId:'running-turn'});
    await loop.poll(h.$);await h.reported('accepted');
    await loop.complete(h.$,{turnId:'running-turn',answer:'Answered both',reason:'answer',isAborted:false});
    clock.now += FOLD_GRACE_MS - 1;
    // The report that stop sends cannot be saved, so the attempt stays held by this loop.
    failing = true;
    await loop.stop(h.$);
    const reported = () => h.calls.filter(call => call.argv[2] === 'report').map(call => JSON.parse(call.options.stdin).kind);
    const turnReports = () => reported().filter(kind => kind === 'turn_started' || kind === 'turn_finished');
    expect(turnReports()).toEqual([]);
    // The unsaved report is queued behind nothing else; the attempt belongs to no turn.
    const held = loop.status();
    expect(held.pending_reports).toBe(1);
    expect(held.active.host_turn_id).toBe(null);
    // The grace period runs out and the next turn starts without the message: a stopped loop must not fold it now.
    clock.now += FOLD_GRACE_MS;
    await loop.start(h.$,{text:'Unrelated next turn',turnId:'next-turn'});
    await loop.complete(h.$,{turnId:'next-turn',answer:'new',reason:'answer',isAborted:false});
    expect(loop.status().active.host_turn_id).toBe(null);
    expect(loop.status().pending_reports).toBe(1);
    failing = false;
    await loop.poll(h.$);
    expect(turnReports()).toEqual([]);
    expect(h.events.some(event => event.kind === 'turn_started' || event.kind === 'turn_finished')).toBe(false);
  });
  it('confirms a pending fold when the loop stops once the grace period ran out with no carrying turn', async () => {
    const value = await prepared();const clock = {now:1000};
    const h = host({claim:value});
    const loop = claimLoop(descriptor.helperPath,binding,{now:() => clock.now});
    await loop.start(h.$,{text:'Owner typed this in Claude',turnId:'running-turn'});
    await loop.poll(h.$);await h.reported('accepted');
    await loop.complete(h.$,{turnId:'running-turn',answer:'Answered both',reason:'answer',isAborted:false});
    expect(h.events.map(event => event.kind)).toEqual(['accepted']);
    clock.now += FOLD_GRACE_MS;
    await loop.stop(h.$,true);
    expect(h.events.map(event => [event.kind,event.host_turn_id])).toEqual([['accepted',null],['turn_started','running-turn'],['turn_finished','running-turn'],['disconnected',null]]);
    expect(h.events[2].payload).toMatchObject({status:'completed',diagnostic_text:'Answered both'});
    expect(h.events.some(event => event.kind === 'uncertain')).toBe(false);
    expect(loop.busy()).toBe(null);
    // The retired loop still never folds a later turn.
    await loop.complete(h.$,{turnId:'next-conversation-turn',answer:'new',reason:'answer',isAborted:false});
    expect(h.events).toHaveLength(4);
  });
  it('reports an accepted message uncertain on stop when no turn that could have held it ended', async () => {
    const value = await prepared();
    const h = host({claim:value});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.start(h.$,{text:'Owner prompt',turnId:'running-turn'});
    await loop.poll(h.$);await h.reported('accepted');
    // A turn that started after acceptance without the message is not a fold candidate.
    await loop.start(h.$,{text:'Unrelated owner prompt',turnId:'later-turn'});
    await loop.complete(h.$,{turnId:'later-turn',answer:'other',reason:'answer',isAborted:false});
    await loop.stop(h.$);
    expect(h.events.map(event => event.kind)).toEqual(['accepted','uncertain']);
    expect(h.events[1]).toMatchObject({host_turn_id:null});
  });
  it('a stopped loop still finishes the message whose turn it saw start', async () => {
    const value = await prepared();
    const h = host({claim:value});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);
    await loop.start(h.$,{text:value.formatted_payload,turnId:'message-turn'});
    await loop.stop(h.$,true);
    await loop.complete(h.$,{turnId:'message-turn',answer:'done',reason:'answer',isAborted:false});
    expect(h.events.map(event => event.kind)).toEqual(['accepted','turn_started','disconnected','turn_finished']);
  });
  it('never credits a turn that started after acceptance without carrying the message', async () => {
    const value = await prepared();
    const h = host({claim:value});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);await h.reported('accepted');
    await loop.start(h.$,{text:'Unrelated owner prompt',turnId:'later-turn'});
    await loop.complete(h.$,{turnId:'later-turn',answer:'other',reason:'answer',isAborted:false});
    expect(h.events.map(event => event.kind)).toEqual(['accepted']);
    expect(loop.busy()).toBe('answering');
  });
  it('delivers a topic-level input with no item ID verbatim to an idle Claude as the user', async () => {
    const wire_marker = `[ARIADNE_INPUT:${ids.input}:${ids.attempt}]`;
    const formatted_payload = `${wire_marker}\n${JSON.stringify({topic_id:ids.session,owner_text:'Please look at this topic'})}`;
    const value = {input_id:ids.input,attempt_id:ids.attempt,binding_generation:ids.generation,wire_marker,formatted_payload,payload_sha256:await hash(formatted_payload)};
    const h = host({claim:value});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);
    expect(h.prompts).toEqual([{text:formatted_payload,asUser:true}]);
    await loop.start(h.$,{text:formatted_payload,turnId:'topic-turn'});
    await loop.complete(h.$,{turnId:'topic-turn',answer:'done',reason:'answer',isAborted:false});
    expect(h.events.map(event => event.kind)).toEqual(['accepted','turn_started','turn_finished']);
    expect(h.events.every(event => event.input_id === ids.input && !('item_id' in event))).toBe(true);
  });
  it('settle retries an unconfirmed claim with its original ID and saves pending reports', async () => {
    const value = await prepared();let fail = true;
    const h = host({claim:value,handler:argv => argv[2] === 'claim' && fail ? failure('delivery_uncertain') : undefined});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);
    expect(loop.busy()).toBe('claim');
    await loop.settle(h.$);
    expect(loop.busy()).toBe('claim');
    fail = false;await loop.settle(h.$);
    const claims = h.calls.filter(call => call.argv[2] === 'claim').map(call => call.argv.at(-1));
    expect(claims).toHaveLength(3);expect(new Set(claims).size).toBe(1);
    // The recovered claim is still delivered; the command then waits for the answer.
    expect(h.prompts).toHaveLength(1);expect(loop.busy()).toBe('answering');
    expect(loop.status().admission_open).toBe(false);
    loop.reopen();expect(loop.status().admission_open).toBe(true);
  });
  it('settle with nothing outstanding makes no new claim and leaves the loop idle', async () => {
    const h = host();
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.settle(h.$);
    expect(h.calls).toEqual([]);expect(loop.busy()).toBe(null);
    loop.reopen();await loop.poll(h.$);
    expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(1);
  });
  it('reports busy while a lifecycle report is unsaved, and settle clears it once the app answers', async () => {
    const value = await prepared();let failing = true;
    const h = host({claim:value,handler:argv => argv[2] === 'report' && failing ? failure() : undefined});
    const loop = claimLoop(descriptor.helperPath,binding);
    await loop.poll(h.$);
    await loop.start(h.$,{text:value.formatted_payload,turnId:'turn'});
    await loop.complete(h.$,{turnId:'turn',answer:'done',reason:'answer',isAborted:false});
    expect(loop.status().pending_reports).toBe(3);
    // Three failed saves, one notice.
    expect(h.logs.filter(log => log === NOTICES.reports)).toHaveLength(1);
    failing = false;await loop.settle(h.$);
    expect(loop.status().pending_reports).toBe(0);
    expect(loop.busy()).toBe(null);
    expect(h.events.map(event => event.kind)).toEqual(['accepted','turn_started','turn_finished']);
  });
});
