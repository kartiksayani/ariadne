import { describe, it, expect, vi } from 'vitest';
import { createRegister } from '../../../integrations/claude/plugin/hooks/register.js';
import { capabilities, deferred, descriptor, failure, host, ids, prepared, status, success } from './fixtures.js';
function callbacks(descriptor) {
  const hooks = new Map();
  // Connect gives up on the first not_found so retained-operation retry stays observable.
  createRegister(descriptor,{waitMs:0,pollMs:0})((name, pattern, handler) => {
    if (typeof pattern === 'function') {handler=pattern;pattern=null;}
    hooks.set(pattern?.command ?? name,pattern?.command ? ($,event = {args:''}) => handler($,event) : handler);
  });
  return hooks;
}
const next = async event => event;
describe('supported Mod entry convention', () => {
  it('announces on startup and thirty-second ticks with validated scope, then cancels intake on session end', async () => {
    const recorded = [];
    const h = host({handler:(argv,options) => {
      if (argv[2] === 'announce') recorded.push(JSON.parse(options.stdin));
    }});
    const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);
    expect(recorded).toHaveLength(1);expect(recorded[0].binding_scope).toBe(null);
    const timer = h.timers().find(timer => timer.ms === 30000);
    expect(timer).toBeDefined();
    await hooks.get('ariadne-connect')(h.$);
    await timer.callback();
    expect(recorded[1].binding_scope).toEqual({binding_id:ids.binding,generation:ids.generation});
    await hooks.get('ariadne-disconnect')(h.$);
    await timer.callback();
    expect(recorded[3].binding_scope).toBe(null);
    await hooks.get('session.end')(h.$,{},next);
    expect(timer.cancelled).toBe(true);await timer.callback();
    expect(recorded).toHaveLength(4);expect(h.prompts).toEqual([]);
  });
  it('announces exact saved IDs before status and retains the connect operation while route publication or its acknowledgement is pending', async () => {
    for (const loseAnnouncementAck of [false,true]) {
      let published = false, lost = false;
      const bound = [];
      const h = host({handler:(argv,options) => {
        if (argv[2] === 'announce') {
          const scope = JSON.parse(options.stdin).binding_scope;
          if (scope) {
            bound.push(scope);
            if (loseAnnouncementAck && !lost) {lost=true;return failure('commit_uncertain');}
          }
        }
        if (argv[2] === 'connection-status' && !published) return failure('not_found');
      }});
      const hooks = callbacks(descriptor);
      await hooks.get('session.start')(h.$,{},next);
      await hooks.get('ariadne-connect')(h.$,{args:ids.session});
      expect(h.logs.at(-1)).toContain('was saved; connection status remains pending');
      expect(bound).toEqual([{binding_id:ids.binding,generation:ids.generation}]);
      const connect = h.calls.find(call => call.argv[1] === 'binding');
      const original = connect.options.stdin;
      await h.timer().callback();
      expect(h.calls.some(call => call.argv[2] === 'claim')).toBe(false);
      expect(h.prompts).toEqual([]);
      await hooks.get('ariadne-connect')(h.$,{args:ids.input});
      expect(h.calls.filter(call => call.argv[1] === 'binding')).toHaveLength(1);
      await h.timers().find(timer => timer.ms === 30000).callback();
      expect(bound.at(-1)).toEqual(bound[0]);
      published = true;
      const retried = await hooks.get('ariadne-connect')(h.$,{args:ids.session});
      expect(retried.text).toContain(`binding ${ids.binding}, generation ${ids.generation}`);
      expect(h.calls.filter(call => call.argv[1] === 'binding').map(call => call.options.stdin)).toEqual([original,original]);
      expect(h.calls.filter(call => call.argv[2] === 'report')).toEqual([]);
      expect(h.prompts).toEqual([]);
    }
  });
  it('can announce an unqualified engine without admitting claims, and heartbeat failure cannot fabricate connection', async () => {
    const h = host({version:'2.1.286'}), hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);
    expect(h.calls.map(call => call.argv[2])).toEqual(['announce']);
    expect(h.timer()).toBe(null);expect(h.events).toEqual([]);expect(h.prompts).toEqual([]);
    await hooks.get('session.end')(h.$,{},next);
    const unsupported = host({handler:argv => argv[2] === 'announce' ? failure('unsupported') : undefined});
    await callbacks(descriptor).get('session.start')(unsupported.$,{},next);
    const heartbeat = unsupported.timers().find(timer => timer.ms === 30000);
    await heartbeat.callback();await heartbeat.callback();
    // One plain notice for the whole outage, not one per heartbeat.
    expect(unsupported.logs).toEqual(['Ariadne: could not reach the Ariadne app. This conversation will show there once the app is running.']);
    expect(unsupported.calls.filter(call => call.argv[2] === 'claim')).toEqual([]);
    expect(unsupported.events).toEqual([]);
  });
  it('reports actual session end for saved scopes pending status or announcement acknowledgement, retaining failed report identity', async () => {
    for (const loseAnnouncementAck of [false,true]) {
      let failReport = true;
      const h = host({handler:(argv,options) => {
        if (argv[2] === 'connection-status') return failure('not_found');
        if (argv[2] === 'announce' && loseAnnouncementAck && JSON.parse(options.stdin).binding_scope) return failure('commit_uncertain');
        if (argv[2] === 'report' && failReport) return failure('commit_uncertain');
      }});
      const hooks = callbacks(descriptor);
      await hooks.get('session.start')(h.$,{},next);
      await hooks.get('ariadne-connect')(h.$,{args:ids.session});
      const original = h.calls.find(call => call.argv[1] === 'binding').options.stdin;
      await hooks.get('ariadne-connect')(h.$,{args:ids.session});
      expect(h.calls.filter(call => call.argv[1] === 'binding').map(call => call.options.stdin)).toEqual([original,original]);
      h.timer().callback();
      expect(h.calls.some(call => call.argv[2] === 'claim')).toBe(false);
      await hooks.get('session.end')(h.$,{},next);
      const failed = h.calls.find(call => call.argv[2] === 'report');
      expect(JSON.parse(failed.options.stdin)).toMatchObject({kind:'disconnected',binding_id:ids.binding,generation:ids.generation,input_id:null,attempt_id:null});
      expect(JSON.parse(failed.options.stdin).event_id).toBe(`claude:session-ended:${ids.binding}:${ids.generation}`);
      failReport = false;
      await hooks.get('session.end')(h.$,{},next);
      const attempts = h.calls.filter(call => call.argv[2] === 'report');
      expect(attempts).toHaveLength(2);
      expect(attempts[1].options.stdin).toBe(failed.options.stdin);
      expect(h.events.map(event => event.kind)).toEqual(['disconnected']);
      expect(h.prompts).toEqual([]);
      expect(h.timers().every(timer => timer.cancelled)).toBe(true);
    }
  });
  it('reports the saved scope when session end overtakes its receipt or a pending status read', async () => {
    for (const heldCommand of ['connect','connection-status']) {
      const entered = deferred(), reply = deferred();
      const h = host({handler:async argv => {
        if (argv[2] === heldCommand) {entered.resolve();await reply.promise;}
        if (argv[2] === 'connection-status') return failure('not_found');
      }});
      const hooks = callbacks(descriptor);
      await hooks.get('session.start')(h.$,{},next);
      const connecting = hooks.get('ariadne-connect')(h.$,{args:ids.session});
      await entered.promise;
      await hooks.get('session.end')(h.$,{},next);
      reply.resolve();
      await connecting;
      expect(h.events).toHaveLength(1);
      expect(h.events[0]).toMatchObject({kind:'disconnected',binding_id:ids.binding,generation:ids.generation,input_id:null,attempt_id:null});
      expect(h.calls.some(call => call.argv[2] === 'claim')).toBe(false);
      expect(h.prompts).toEqual([]);
      expect(h.timers().every(timer => timer.cancelled)).toBe(true);
    }
  });
  it('keeps distinct old and pending saved scopes through session end without replacing failed old evidence', async () => {
    let connects = 0, holdStatus = false, failOldReport = true;
    const h = host({handler:(argv,options) => {
      if (argv[1] === 'binding' && ++connects === 2) {
        holdStatus = true;
        return success({operation_id:JSON.parse(options.stdin).command.op_id,session_id:ids.session,revision:2,
          data:{kind:'binding_connect',binding_id:ids.input,generation:ids.attempt,
            capabilities:capabilities(),setup_instruction:'Exact saved instruction.'}});
      }
      if (argv[2] === 'connection-status' && holdStatus) return failure('not_found');
      if (argv[2] === 'report' && JSON.parse(options.stdin).binding_id === ids.binding && failOldReport) return failure('commit_uncertain');
    }});
    const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$,{args:ids.session});
    await hooks.get('ariadne-connect')(h.$,{args:ids.session});
    await hooks.get('session.end')(h.$,{},next);
    const reports = h.calls.filter(call => call.argv[2] === 'report');
    expect(reports.map(call => JSON.parse(call.options.stdin))).toMatchObject([
      {binding_id:ids.binding,generation:ids.generation,kind:'disconnected'},
      {binding_id:ids.input,generation:ids.attempt,kind:'disconnected'},
    ]);
    failOldReport = false;
    await hooks.get('session.end')(h.$,{},next);
    expect(h.calls.filter(call => call.argv[2] === 'report')).toHaveLength(3);
    expect(h.calls.at(-1).options.stdin).toBe(reports[0].options.stdin);
    expect(h.calls.some(call => call.argv[2] === 'claim')).toBe(false);
    expect(h.prompts).toEqual([]);
  });
  it('does not create a poll timer after session end overtakes the bounded startup announcement', async () => {
    const entered = deferred(), reply = deferred();
    const h = host({handler:async argv => {if (argv[2] === 'announce') {entered.resolve();await reply.promise;}}});
    const hooks = callbacks(descriptor), starting = hooks.get('session.start')(h.$,{},next);
    await entered.promise;await hooks.get('session.end')(h.$,{},next);reply.resolve();await starting;
    expect(h.timer()).toBe(null);expect(h.timers()).toHaveLength(1);
    expect(h.timers()[0].cancelled).toBe(true);expect(h.calls).toHaveLength(1);
    expect(h.prompts).toEqual([]);expect(h.events).toEqual([]);
  });
  it('uses the SDK optional session selector and appends resume guidance without changing canonical instructions', async () => {
    const h = host();const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);
    const result = await hooks.get('ariadne-connect')(h.$,{args:` ${ids.session} `});
    const [summary,command,advice,...guidance] = result.text.split('\n');
    expect(summary).toBe(`Ariadne connected: binding ${ids.binding}, generation ${ids.generation}.`);
    expect(command).toBe(`Command: ${descriptor.helperPath}`);
    expect(advice).toBe('File your work as you go; the ariadne skill has the rest.');
    // The inline rules live in the skill, not in the connect output.
    expect(result.text).not.toContain('[ARIADNE_INPUT:');
    expect(result.text).not.toContain('Never edit .ariadne/');
    expect(result.text).not.toContain('"instruction"');
    expect(guidance.join('\n')).toBe('This resumes an earlier session: read reconnect.md in the ariadne skill first.');
    expect(h.calls.filter(call => call.argv[1] === 'binding').map(call => JSON.parse(call.options.stdin).command.params.existing_session_id)).toEqual([ids.session]);
    expect(h.prompts).toEqual([]);
    // The command output carries the routing; no extra conversation note.
    expect(h.appended).toEqual([]);
  });
  it('rejects malformed selectors before owner transitions and never infers a session', async () => {
    const h = host();const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);
    for (const event of [{},{args:42},{args:'ProjectA'},{args:`${ids.session} ${ids.input}`},{args:'x'.repeat(65)}]) {
      expect((await hooks.get('ariadne-connect')(h.$,event)).text).toContain('did not complete');
    }
    expect(h.calls.filter(call => call.argv[1] === 'binding' || call.argv[1] === 'project')).toEqual([]);
    await hooks.get('ariadne-connect')(h.$,{args:''});
    expect(JSON.parse(h.calls.find(call => call.argv[1] === 'binding').options.stdin).command.params.existing_session_id).toBe(null);
    expect(h.prompts).toEqual([]);
  });
  it('registers all commands, guarded one-second poll, scoped status/disconnect and session-end timer cancellation', async () => {
    const h = host();const hooks = callbacks(descriptor);
    const start = {kind:'existing-session'};
    expect(await hooks.get('session.start')(h.$,start,next)).toBe(start);
    expect(h.commands.map(command => command.name)).toEqual(['ariadne-connect','ariadne-status','ariadne-disconnect']);
    expect(h.commands[0].argumentHint).toBe('[session-id]');
    expect(h.timer().ms).toBe(1000);
    const result = await hooks.get('ariadne-connect')(h.$);
    expect(result.text).toMatch(/^Ariadne connected: binding \S+, generation \S+\.\nCommand: \/\S+\nFile your work as you go; the ariadne skill has the rest\.$/);
    expect(result.text).toContain(descriptor.helperPath);
    expect(result.text).not.toContain('{');
    expect(JSON.parse((await hooks.get('ariadne-status')(h.$)).text).binding.connection_state).toBe('connected');
    h.timer().callback();
    // Explicit shutdown drains the in-flight bounded helper operation.
    const event = {kind:'end'};
    expect(await hooks.get('session.end')(h.$,event,next)).toBe(event);
    expect(h.timer().cancelled).toBe(true);
  });
  it('keeps commands actionable with missing/mismatched descriptor/host and never connects or polls', async () => {
    for (const [config,version] of [[null,'2.1.287'],[descriptor,'2.1.286'],[{...descriptor,helperPath:'ariadne'},'2.1.287']]) {
      const h = host({version});const hooks = callbacks(config);
      await hooks.get('session.start')(h.$,{},next);
      expect(h.timer()).toBe(null);expect(h.calls.filter(call => call.argv[2] !== 'announce')).toEqual([]);
      expect((await hooks.get('ariadne-connect')(h.$)).text).toContain('did not complete');
      expect(h.logs.some(log => log.includes('matching') || log.includes('2.1.287'))).toBe(true);
      expect(h.calls.filter(call => call.argv[2] !== 'announce')).toEqual([]);
    }
  });
  it('forwards matching captured turn callbacks and blocks reconnect/disconnect with unsettled original work', async () => {
    const value = await prepared();const submission = deferred();
    const h = host({claim:value,submit:() => submission.promise});const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    h.timer().callback();
    // Start waits until claim/helper submit admission through a deterministic barrier.
    // Poll directly is exercised separately; here signal the SDK submit itself.
    const submitted = h.prompts.length ? Promise.resolve() : new Promise(resolve => {
      const original = h.$.prompt.submit;
      h.$.prompt.submit = args => {const result=original(args);resolve();return result;};
    });
    await submitted;
    expect((await hooks.get('ariadne-connect')(h.$)).text).toBe('Claude is still answering a message from Ariadne. Run the command again after it finishes.');
    expect((await hooks.get('ariadne-disconnect')(h.$)).text).toContain('still answering');
    const start = {text:value.formatted_payload,turnId:'actual'};
    expect(await hooks.get('turn.start')(h.$,start,next)).toBe(start);
    const end = {turnId:'actual',answer:'Done',reason:'answer',isAborted:false};
    expect(await hooks.get('turn.complete')(h.$,end,next)).toBe(end);
    expect(h.events.map(event => event.kind)).toEqual(['accepted','turn_started','turn_finished']);
    submission.resolve({text:value.formatted_payload});
    await hooks.get('session.end')(h.$,{},next);
    expect(h.events.at(-1).kind).toBe('disconnected');
  });
  it('runs explicit disconnect without sending a model prompt and hides raw SDK/helper errors', async () => {
    const h = host();const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    expect(JSON.parse((await hooks.get('ariadne-disconnect')(h.$)).text).data.kind).toBe('binding_state');
    expect(h.prompts).toEqual([]);
    const error = host({handler:() => {throw new Error('raw private process detail');}});
    const failed = callbacks(descriptor);await failed.get('session.start')(error.$,{},next);
    expect(error.logs.join(' ')).not.toContain('raw private');
  });
  it('quiesces old poll admission before awaiting a reconnect receipt', async () => {
    const entered = deferred(), receipt = deferred();let connects = 0;
    const value = await prepared();
    const h = host({claim:value,handler:async argv => {
      if (argv[1] === 'binding' && argv[2] === 'connect' && ++connects === 2) {
        entered.resolve();await receipt.promise;
      }
    }});
    const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    const reconnect = hooks.get('ariadne-connect')(h.$);await entered.promise;
    h.timer().callback();
    // Status is a deterministic asynchronous barrier while the owner call is held.
    const local = JSON.parse((await hooks.get('ariadne-status')(h.$)).text).local;
    expect(local.admission_open).toBe(false);
    expect(h.calls.filter(call => call.argv[2] === 'claim')).toEqual([]);
    receipt.resolve();await reconnect;
    expect(h.prompts).toEqual([]);
  });
  it('serializes concurrent owner operations without replacing a newly active claim loop', async () => {
    const entered = deferred(), receipt = deferred(), submitted = deferred(), submission = deferred();let connects = 0;
    const value = await prepared();
    const h = host({claim:value,submit:() => {submitted.resolve();return submission.promise;},handler:async argv => {
      if (argv[1] === 'binding' && argv[2] === 'connect' && ++connects === 2) {entered.resolve();await receipt.promise;}
    }});
    const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    const reconnect = hooks.get('ariadne-connect')(h.$);await entered.promise;
    expect((await hooks.get('ariadne-connect')(h.$)).text).toContain('already connecting or disconnecting');
    expect((await hooks.get('ariadne-disconnect')(h.$)).text).toContain('already connecting or disconnecting');
    expect(connects).toBe(2);
    receipt.resolve();await reconnect;h.timer().callback();await submitted.promise;
    await hooks.get('turn.start')(h.$,{text:value.formatted_payload,turnId:'retained-turn'},next);
    expect(h.events.map(event => event.kind)).toEqual(['accepted','turn_started']);
    expect(h.events.every(event => event.attempt_id === ids.attempt)).toBe(true);
    submission.resolve({text:value.formatted_payload});
    await hooks.get('session.end')(h.$,{},next);
  });
  it('delivers a claim that lands while a reconnect waits, keeps its unsaved report, and refuses the rotation in plain words', async () => {
    const entered = deferred(), claim = deferred();const value = await prepared();
    const h = host({claim:value,handler:async argv => {
      if (argv[2] === 'claim') {entered.resolve();return claim.promise;}
      if (argv[2] === 'report') return failure('commit_uncertain');
    }});const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    h.timer().callback();await entered.promise;
    const reconnect = hooks.get('ariadne-connect')(h.$);
    expect(h.calls.filter(call => call.argv[1] === 'binding')).toHaveLength(1);
    claim.resolve({exitCode:0,stdout:JSON.stringify({api_version:1,ok:true,data:value}),stderr:''});
    expect((await reconnect).text).toContain('Claude is still answering a message from Ariadne');
    expect(h.prompts).toEqual([{text:value.formatted_payload,asUser:true}]);
    const local = JSON.parse((await hooks.get('ariadne-status')(h.$)).text).local;
    expect(local.active).toEqual({input_id:ids.input,attempt_id:ids.attempt,host_turn_id:null});
    // The refused command does not leave this conversation shut to new messages.
    expect(local.admission_open).toBe(true);
    expect((await hooks.get('ariadne-disconnect')(h.$)).text).toContain('still answering');
    const acceptance = () => h.calls.filter(call => call.argv[2] === 'report' && JSON.parse(call.options.stdin).kind === 'accepted');
    await vi.waitFor(() => expect(acceptance().length).toBeGreaterThan(0));
    await h.timer().callback();
    await vi.waitFor(() => expect(acceptance().length).toBeGreaterThan(1));
    await hooks.get('session.end')(h.$,{},next);
    const reports = h.calls.filter(call => call.argv[2] === 'report').map(call => JSON.parse(call.options.stdin));
    expect(reports[0]).toMatchObject({binding_id:ids.binding,generation:ids.generation,attempt_id:ids.attempt,kind:'accepted'});
    // The unsaved acceptance is retried with its original event, never replaced.
    const accepted = reports.filter(report => report.kind === 'accepted');
    expect(accepted.length).toBeGreaterThan(1);
    expect(accepted.every(report => report.event_id === reports[0].event_id)).toBe(true);
    expect(h.calls.filter(call => call.argv[1] === 'binding')).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);
  });
  it('retries an unconfirmed claim with its original request ID before refusing an owner command', async () => {
    const entered = deferred(), claim = deferred();
    const h = host({handler:async argv => {if (argv[2] === 'claim') {entered.resolve();return claim.promise;}}});
    const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    h.timer().callback();await entered.promise;
    const reconnect = hooks.get('ariadne-connect')(h.$);claim.resolve(failure('delivery_uncertain'));
    expect((await reconnect).text).toBe('Ariadne could not confirm a message it was fetching from the app. Make sure the Ariadne app is open, then run the command again.');
    const original = h.calls.find(call => call.argv[2] === 'claim').argv.at(-1);
    const local = JSON.parse((await hooks.get('ariadne-status')(h.$)).text).local;
    expect(local.pending_claim_request_id).toBe(original);expect(local.admission_open).toBe(true);
    await h.timer().callback();
    await vi.waitFor(() => expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(3));
    await hooks.get('session.end')(h.$,{},next);
    const claims = h.calls.filter(call => call.argv[2] === 'claim').map(call => call.argv.at(-1));
    expect(claims.every(id => id === original)).toBe(true);expect(h.prompts).toEqual([]);
    expect(h.calls.filter(call => call.argv[1] === 'binding')).toHaveLength(1);
  });
  it('heals an unconfirmed claim during an owner command and then runs the command', async () => {
    let fail = true;
    const h = host({handler:argv => {if (argv[2] === 'claim') return fail ? failure('delivery_uncertain') : success(null);}});
    const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    await h.timer().callback();
    await vi.waitFor(() => expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(1));
    fail = false;
    expect((await hooks.get('ariadne-disconnect')(h.$)).text).toContain('binding_state');
    const claims = h.calls.filter(call => call.argv[2] === 'claim').map(call => call.argv.at(-1));
    expect(claims).toHaveLength(2);expect(claims[1]).toBe(claims[0]);
  });
  for (const [name,refusal] of [['paused in the app',() => failure('invalid_transition',{reason:'owner_paused'})],
    ['not held by the app',() => failure('not_found',{reason:'lease_invalid'})]]) {
    it(`disconnects while the session is ${name}, without claiming a message is unconfirmed`, async () => {
      const h = host({handler:argv => argv[2] === 'claim' ? refusal() : undefined});
      const hooks = callbacks(descriptor);
      await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
      await h.timer().callback();
      await vi.waitFor(() => expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(1));
      const result = (await hooks.get('ariadne-disconnect')(h.$)).text;
      expect(result).not.toBe('Ariadne could not confirm a message it was fetching from the app. Make sure the Ariadne app is open, then run the command again.');
      expect(JSON.parse(result).data.kind).toBe('binding_state');
      expect(h.prompts).toEqual([]);
    });
  }
  it('allows a drained empty claim but keeps the original owner operation and old loop after a negative reconnect', async () => {
    const entered = deferred(), claim = deferred();let connects = 0;
    const h = host({handler:async argv => {
      if (argv[2] === 'claim') {entered.resolve();return claim.promise;}
      if (argv[1] === 'binding' && argv[2] === 'connect' && ++connects === 2) return failure();
    }});const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    h.timer().callback();await entered.promise;
    const reconnect = hooks.get('ariadne-connect')(h.$);
    claim.resolve({exitCode:0,stdout:JSON.stringify({api_version:1,ok:true,data:null}),stderr:''});
    expect((await reconnect).text).toContain('did not complete');
    const local = JSON.parse((await hooks.get('ariadne-status')(h.$)).text).local;
    // A failed owner command reopens the old loop instead of shutting it for good.
    expect(local.active).toBe(null);expect(local.admission_open).toBe(true);
    await hooks.get('ariadne-connect')(h.$);
    const mutations = h.calls.filter(call => call.argv[1] === 'binding');
    expect(mutations).toHaveLength(3);expect(mutations[2].options.stdin).toBe(mutations[1].options.stdin);
    expect(h.prompts).toEqual([]);
  });

  it('does not restart polling when session end precedes a late owner receipt', async () => {
    const entered = deferred(), receipt = deferred();
    const h = host({handler:async argv => {if (argv[1] === 'binding') {entered.resolve();await receipt.promise;}}});
    const hooks = callbacks(descriptor);await hooks.get('session.start')(h.$,{},next);
    const connect = hooks.get('ariadne-connect')(h.$);await entered.promise;
    await hooks.get('session.end')(h.$,{},next);receipt.resolve();await connect;
    expect(h.events.map(event => event.kind)).toEqual(['disconnected']);
    expect(h.events[0]).toMatchObject({binding_id:ids.binding,generation:ids.generation,input_id:null,attempt_id:null});
    h.timer().callback();
    expect((await hooks.get('ariadne-connect')(h.$)).text).toContain('conversation has ended');
    expect(h.calls.filter(call => call.argv[2] === 'claim')).toEqual([]);expect(h.prompts).toEqual([]);
    expect(h.timer().cancelled).toBe(true);
  });

  it('preserves failed old-scope session-end evidence while a reconnect receipt is awaited', async () => {
    const entered = deferred(), receipt = deferred();let connects = 0;
    const h = host({handler:async argv => {
      if (argv[1] === 'binding' && ++connects === 2) {entered.resolve();await receipt.promise;}
      if (argv[2] === 'report') return failure('commit_uncertain');
    }});const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    const reconnect = hooks.get('ariadne-connect')(h.$);await entered.promise;
    await hooks.get('session.end')(h.$,{},next);receipt.resolve();
    expect((await reconnect).text).toContain("could not save Claude's last progress");
    const local = JSON.parse((await hooks.get('ariadne-status')(h.$)).text).local;
    expect(local.pending_reports).toBe(1);expect(local.stopped).toBe(true);
    const original = h.calls.find(call => call.argv[2] === 'report').options.stdin;
    expect(JSON.parse(original)).toMatchObject({kind:'disconnected',generation:ids.generation});
    await hooks.get('session.end')(h.$,{},next);
    expect(h.calls.filter(call => call.argv[2] === 'report').every(call => call.options.stdin === original)).toBe(true);
    expect(h.prompts).toEqual([]);
  });

  it('retains a late contradictory callback instead of replacing its loop after an owner receipt', async () => {
    const entered = deferred(), receipt = deferred(), submitted = deferred(), reportEntered = deferred(), report = deferred();let connects = 0;
    const value = await prepared();
    const h = host({claim:value,submit:() => {submitted.resolve();return Promise.resolve({text:value.formatted_payload});},handler:async (argv,options) => {
      if (argv[1] === 'binding' && ++connects === 2) {entered.resolve();await receipt.promise;}
      if (argv[2] === 'report' && JSON.parse(options.stdin).payload.diagnostic_text === 'changed') {reportEntered.resolve();return report.promise;}
    }});const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    h.timer().callback();await submitted.promise;
    await hooks.get('turn.start')(h.$,{text:value.formatted_payload,turnId:'original-turn'},next);
    await hooks.get('turn.complete')(h.$,{turnId:'original-turn',answer:'first',reason:'answer',isAborted:false},next);
    const reconnect = hooks.get('ariadne-connect')(h.$);await entered.promise;
    const callback = hooks.get('turn.complete')(h.$,{turnId:'original-turn',answer:'changed',reason:'answer',isAborted:false},next);
    await reportEntered.promise;receipt.resolve();
    expect((await reconnect).text).toContain('still answering');
    report.resolve(failure('protocol_conflict'));await callback;
    const local = JSON.parse((await hooks.get('ariadne-status')(h.$)).text).local;
    // Admission reopens, but the unsaved report still goes before any claim.
    expect(local.pending_reports).toBe(1);expect(local.admission_open).toBe(true);
    const retained = h.calls.filter(call => call.argv[2] === 'report').at(-1).options.stdin;
    expect(JSON.parse(retained)).toMatchObject({generation:ids.generation,attempt_id:ids.attempt,host_turn_id:'original-turn',payload:{diagnostic_text:'changed'}});
    h.timer().callback();await hooks.get('session.end')(h.$,{},next);
    expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(1);expect(h.prompts).toHaveLength(1);
  });

});

// The app side of a reconnect: each connect rotates the generation, and status
// reports whichever Claude conversation is current.
function rotatingApp({store, claim = null, before = () => undefined} = {}) {
  const generations = [ids.generation,ids.attempt,ids.input];
  let connects = 0, current = ids.generation, h = null;
  h = host({store,claim,handler:async (argv,options) => {
    const custom = await before(argv,options);
    if (custom !== undefined) return custom;
    if (argv[1] === 'binding' && argv[2] === 'connect') {
      const request = JSON.parse(options.stdin);
      current = generations[connects++ % generations.length];
      return success({operation_id:request.command.op_id,session_id:ids.session,revision:2,
        data:{kind:'binding_connect',binding_id:ids.binding,generation:current,capabilities:capabilities(),setup_instruction:'Exact saved instruction.'}});
    }
    if (argv[2] === 'connection-status') return success({...status,generation:current,external_session_id:await h.$.session.id()});
  }});
  return h;
}
const connects = h => h.calls.filter(call => call.argv[1] === 'binding' && call.argv[2] === 'connect').map(call => JSON.parse(call.options.stdin).command.params);
const announced = h => h.calls.filter(call => call.argv[2] === 'announce').map(call => JSON.parse(call.options.stdin));
const claimScopes = h => h.calls.filter(call => call.argv[2] === 'claim').map(call => call.argv[6]);

describe('conversation changes, relaunch and removal', () => {
  it('follows /clear to the same Ariadne session, announcing the new conversation at once', async () => {
    const h = rotatingApp();const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);
    await hooks.get('ariadne-connect')(h.$,{args:ids.session});
    await hooks.get('session.end')(h.$,{reason:'clear',sessionId:'original-host-session'},next);
    // The old conversation's end is reported; the process keeps its timers.
    expect(h.events.map(event => [event.kind,event.generation])).toEqual([['disconnected',ids.generation]]);
    expect(h.timers().some(timer => timer.cancelled)).toBe(false);
    h.switchSession('cleared-conversation');
    h.timer().callback();
    await vi.waitFor(() => expect(connects(h)).toHaveLength(2));
    await vi.waitFor(() => expect(h.logs).toContain('Ariadne: this conversation is connected to its Ariadne session again.'));
    expect(connects(h)[1]).toMatchObject({external_session_id:'cleared-conversation',existing_session_id:ids.session});
    const fresh = announced(h).filter(body => body.external_session_id === 'cleared-conversation');
    expect(fresh[0].binding_scope).toBe(null);
    expect(fresh.at(-1).binding_scope).toEqual({binding_id:ids.binding,generation:ids.attempt});
    await h.timer().callback();
    await vi.waitFor(() => expect(claimScopes(h)).toContain(ids.attempt));
    expect(claimScopes(h)).not.toContain(ids.generation);
    expect(h.store.get('binding:cleared-conversation')).toMatchObject({project_id:ids.project,session_id:ids.session});
    expect(h.store.has('binding:original-host-session')).toBe(false);
    expect(h.logs.join('\n')).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(h.prompts).toEqual([]);
    // Claude learns the new routing from a conversation note, not a prompt.
    expect(h.appended).toHaveLength(1);
    const [note] = h.appended;
    expect(note.message.type).toBe('user');
    expect(note.message.content).toHaveLength(1);
    expect(note.message.content[0].type).toBe('text');
    // The skill tells Claude to look for this opening.
    expect(note.message.content[0].text).toMatch(/^Ariadne reconnected this conversation /);
    expect(note.message.content[0].text).toContain(`binding ${ids.binding} and generation ${ids.attempt}`);
    expect(note.message.content[0].text).not.toContain(ids.generation);
    // A fresh context is sent to reconnect.md, which holds the one-time read.
    expect(note.message.content[0].text).toContain('read reconnect.md in the ariadne skill first');
    expect(note.message.content[0].text).not.toMatch(/run ariadne read/);
    // The note carries the same Command line as the connect summary, so a fresh context can run it.
    expect(note.message.content[0].text.split('\n')).toContain(`Command: ${descriptor.helperPath}`);
  });
  it('shell-quotes a helper path that needs it, in the connect summary and in the reconnect note', async () => {
    for (const [helperPath,printed] of [
      ['/Users/o wner/Ariadne App/bin/ariadne',`'/Users/o wner/Ariadne App/bin/ariadne'`],
      ["/Users/o'wner/bin/ariadne",`'/Users/o'\\''wner/bin/ariadne'`],
      ['/installed/ariadne-1.0_x/bin/ariadne','/installed/ariadne-1.0_x/bin/ariadne'],
    ]) {
      const config = {...descriptor,helperPath};
      const h = rotatingApp();const hooks = callbacks(config);
      await hooks.get('session.start')(h.$,{},next);
      const summary = (await hooks.get('ariadne-connect')(h.$,{args:ids.session})).text;
      expect(summary.split('\n')[1]).toBe(`Command: ${printed}`);
      await hooks.get('session.end')(h.$,{reason:'clear'},next);
      await h.timer().callback();
      await vi.waitFor(() => expect(h.appended).toHaveLength(1));
      expect(h.appended[0].message.content[0].text.split('\n')).toContain(`Command: ${printed}`);
    }
  });
  it('prints the closed-app notice again in the new conversation after a conversation change', async () => {
    const h = rotatingApp({before:argv => argv[2] === 'announce' ? failure('unsupported') : undefined});
    const hooks = callbacks(descriptor);
    const outage = 'Ariadne: could not reach the Ariadne app. This conversation will show there once the app is running.';
    await hooks.get('session.start')(h.$,{},next);
    const heartbeat = h.timers().find(timer => timer.ms === 30000);
    await heartbeat.callback();
    expect(h.logs.filter(log => log === outage)).toHaveLength(1);
    h.switchSession('new-conversation');
    await hooks.get('session.end')(h.$,{reason:'clear'},next);
    await h.timer().callback();
    await vi.waitFor(() => expect(h.logs.filter(log => log === outage)).toHaveLength(2));
    await heartbeat.callback();
    expect(h.logs.filter(log => log === outage)).toHaveLength(2);
  });
  it('after /clear while the app cannot save, never finishes the old message with the new conversation\'s answer', async () => {
    const value = await prepared();let claims = 0, down = false;
    const h = rotatingApp({claim:value,before:argv => {
      if (argv[2] === 'claim') return ++claims === 1 ? success(value) : success(null);
      if (argv[2] === 'report' && down) return failure('host_unreachable');
    }});
    const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$,{args:ids.session});
    await h.timer().callback();
    await vi.waitFor(() => expect(h.events.map(event => event.kind)).toEqual(['accepted']));
    down = true;
    await hooks.get('session.end')(h.$,{reason:'clear'},next);
    h.switchSession('cleared-conversation');
    await hooks.get('turn.complete')(h.$,{turnId:'new-conversation-turn',answer:'Answer for the new conversation',reason:'answer',isAborted:false},next);
    down = false;
    await h.timers().find(timer => timer.ms === 30000).callback();
    await vi.waitFor(() => expect(h.events.map(event => event.kind)).toEqual(['accepted','uncertain','disconnected']));
    expect(h.events[1]).toMatchObject({attempt_id:ids.attempt,generation:ids.generation,host_turn_id:null});
    expect(JSON.stringify(h.events)).not.toContain('Answer for the new conversation');
  });
  it('reconnects on the next poll tick when /clear keeps the conversation ID', async () => {
    const h = rotatingApp();const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    await hooks.get('session.end')(h.$,{reason:'clear'},next);
    expect(connects(h)).toHaveLength(1);
    await h.timer().callback();
    await vi.waitFor(() => expect(connects(h)).toHaveLength(2));
    expect(connects(h)[1]).toMatchObject({external_session_id:'original-host-session',existing_session_id:ids.session});
    await vi.waitFor(() => expect(h.appended).toHaveLength(1));
    expect(h.appended[0].message.content[0].text).toContain(`generation ${ids.attempt}`);
  });
  it('retries the routing note on the poll tick while the engine has no conversation to take it', async () => {
    let refuse = true;
    const store = new Map([['binding:original-host-session',{project_id:ids.project,session_id:ids.session,saved_at:'2026-01-01T00:00:00.000Z'}]]);
    const h = host({store,append:async () => {if (refuse) throw new Error('$.session.append: this process keeps no conversation to append to');return {uuid:'row'};}});
    const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);
    await vi.waitFor(() => expect(h.logs).toContain('Ariadne: this conversation is connected to its Ariadne session again.'));
    expect(h.appended).toEqual([]);
    expect(h.logs.join('\n')).not.toContain('append');
    refuse = false;await h.timer().callback();
    await vi.waitFor(() => expect(h.appended).toHaveLength(1));
    await h.timer().callback();
    expect(h.appended).toHaveLength(1);
  });
  it('follows a conversation change it only notices on the poll timer', async () => {
    const h = rotatingApp();const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    h.switchSession('resumed-elsewhere');
    h.timer().callback();
    await vi.waitFor(() => expect(connects(h)).toHaveLength(2));
    expect(connects(h)[1]).toMatchObject({external_session_id:'resumed-elsewhere',existing_session_id:ids.session});
    expect(h.events.map(event => event.kind)).toEqual(['disconnected']);
  });
  it('keeps announcing an idle conversation after /clear so the app can offer it', async () => {
    const h = rotatingApp();const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);
    h.switchSession('idle-after-clear');
    await hooks.get('session.end')(h.$,{reason:'clear'},next);
    const heartbeat = h.timers().find(timer => timer.ms === 30000);
    await heartbeat.callback();await heartbeat.callback();
    const bodies = announced(h).filter(body => body.external_session_id === 'idle-after-clear');
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    expect(bodies.every(body => body.binding_scope === null)).toBe(true);
    // A conversation that was never connected is only announced, never bound.
    expect(connects(h)).toEqual([]);
  });
  it('reconnects a resumed conversation after relaunch from the plugin store, and never binds a new one', async () => {
    const store = new Map();
    const first = rotatingApp({store});const hooks = callbacks(descriptor);
    await hooks.get('session.start')(first.$,{},next);await hooks.get('ariadne-connect')(first.$,{args:ids.session});
    await hooks.get('session.end')(first.$,{},next);
    expect([...store.keys()]).toEqual(['binding:original-host-session']);
    // `claude --resume`: a new process, same Claude conversation.
    const resumed = rotatingApp({store});const again = callbacks(descriptor);
    await again.get('session.start')(resumed.$,{},next);
    await vi.waitFor(() => expect(resumed.logs).toContain('Ariadne: this conversation is connected to its Ariadne session again.'));
    expect(connects(resumed)).toEqual([expect.objectContaining({external_session_id:'original-host-session',existing_session_id:ids.session})]);
    // The resumed conversation still holds the old routing; a note replaces it.
    expect(resumed.appended.map(row => row.message.content[0].text)).toEqual([expect.stringContaining(`generation ${ids.generation}`)]);
    await resumed.timer().callback();
    await vi.waitFor(() => expect(claimScopes(resumed)).toHaveLength(1));
    // A brand-new conversation in the same project only announces itself.
    const fresh = rotatingApp({store});fresh.switchSession('brand-new-conversation');
    await callbacks(descriptor).get('session.start')(fresh.$,{},next);
    await fresh.timers().find(timer => timer.ms === 30000).callback();
    expect(connects(fresh)).toEqual([]);
    expect(announced(fresh).every(body => body.binding_scope === null)).toBe(true);
  });
  it('forgets the remembered session on an explicit disconnect', async () => {
    const store = new Map();
    const h = rotatingApp({store});const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    expect(store.size).toBe(1);
    await hooks.get('ariadne-disconnect')(h.$);
    expect(store.size).toBe(0);
    expect((await hooks.get('ariadne-disconnect')(h.$)).text).toBe('This conversation is not connected to Ariadne.');
    const relaunched = rotatingApp({store});
    await callbacks(descriptor).get('session.start')(relaunched.$,{},next);
    expect(connects(relaunched)).toEqual([]);
  });
  it('tells the owner once when the remembered session is gone, and stops trying', async () => {
    const store = new Map([['binding:original-host-session',{project_id:ids.project,session_id:ids.session,saved_at:'2026-01-01T00:00:00.000Z'}]]);
    const h = rotatingApp({store,before:argv => argv[1] === 'binding' ? failure('not_found') : undefined});
    const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);
    await vi.waitFor(() => expect(h.logs).toContain('Ariadne: the Ariadne session for this conversation no longer exists. Run /ariadne-connect to connect again.'));
    const heartbeat = h.timers().find(timer => timer.ms === 30000);
    await heartbeat.callback();await heartbeat.callback();
    expect(connects(h)).toHaveLength(1);expect(store.size).toBe(0);
    expect(h.logs.filter(log => log.includes('no longer exists'))).toHaveLength(1);
  });
  it('says once that the session is connected to another conversation, and retries quietly until the app accepts', async () => {
    let refuse = true;
    const store = new Map([['binding:original-host-session',{project_id:ids.project,session_id:ids.session,saved_at:'2026-01-01T00:00:00.000Z'}]]);
    const h = rotatingApp({store,before:argv => argv[1] === 'binding' && refuse ? failure('binding_conflict') : undefined});
    const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);
    await vi.waitFor(() => expect(connects(h)).toHaveLength(1));
    const heartbeat = h.timers().find(timer => timer.ms === 30000);
    await heartbeat.callback();
    expect(connects(h)).toHaveLength(2);
    expect(h.logs.filter(log => log === 'This Ariadne session is connected to another conversation.')).toHaveLength(1);
    refuse = false;await heartbeat.callback();
    expect(h.logs.at(-1)).toBe('Ariadne: this conversation is connected to its Ariadne session again.');
    expect(store.size).toBe(1);
  });
  it('stops polling once and stays discoverable when the app removed the session', async () => {
    const store = new Map();
    const h = rotatingApp({store,before:argv => argv[2] === 'claim' ? failure('not_found',{reason:'session_removed'}) : undefined});
    const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    await h.timer().callback();
    await vi.waitFor(() => expect(h.logs).toContain('This session was removed from Ariadne (or connected elsewhere). Run /ariadne-connect to connect again.'));
    await h.timer().callback();await h.timer().callback();
    const heartbeat = h.timers().find(timer => timer.ms === 30000);
    await heartbeat.callback();
    expect(claimScopes(h)).toHaveLength(1);
    expect(announced(h).at(-1).binding_scope).toBe(null);
    expect(h.logs.filter(log => log.startsWith('This session was removed'))).toHaveLength(1);
    expect(store.size).toBe(0);
    expect(connects(h)).toHaveLength(1);
  });
  it('falls back to an unbound announcement when the app no longer knows the bound scope', async () => {
    const h = rotatingApp({before:(argv,options) => argv[2] === 'announce' && JSON.parse(options.stdin).binding_scope ? failure('stale_generation') : undefined});
    const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);
    await hooks.get('ariadne-connect')(h.$);
    const before = h.logs.length;
    await h.timers().find(timer => timer.ms === 30000).callback();
    const last = announced(h).slice(-2);
    expect(last.map(body => body.binding_scope === null)).toEqual([false,true]);
    expect(h.logs.slice(before)).toEqual([]);
  });
  it('tells the owner once per outage, in plain words, and again only after the app recovered and failed again', async () => {
    const closed = "Ariadne isn't open, so this session's work isn't being recorded. Open Ariadne and it will reconnect.";
    let down = false;
    const h = host({handler:argv => down && argv[1] !== '--version' ? failure('host_unreachable') : undefined});
    const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    const quiet = h.logs.length;
    down = true;
    // The first heartbeat and every command in the outage share one notice, yet each command still answers.
    const beat = h.timers().find(timer => timer.ms === 30000);
    await beat.callback();
    for (let i = 0; i < 3; i += 1) expect((await hooks.get('ariadne-status')(h.$)).text).toBe(`That did not complete. ${closed}`);
    await beat.callback();
    expect(h.logs.slice(quiet)).toEqual([closed]);
    down = false;
    await beat.callback();
    expect(JSON.parse((await hooks.get('ariadne-status')(h.$)).text).binding.generation).toBe(ids.generation);
    expect(h.logs.slice(quiet)).toEqual([closed]);
    down = true;
    await hooks.get('ariadne-status')(h.$);
    await hooks.get('ariadne-status')(h.$);
    expect(h.logs.slice(quiet)).toEqual([closed,closed]);
    expect(h.logs.join(' ')).not.toMatch(/host_unreachable|retain|original IDs|helper/);
  });
  it('gives each helper failure code its own plain sentence with a next step, shown once per change of state', async () => {
    let code = 'stale_generation', details, armed = false;
    const h = host({handler:argv => armed && argv[2] === 'connection-status' ? failure(code,details) : undefined});
    const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    armed = true;
    const before = h.logs.length;
    const say = async () => (await hooks.get('ariadne-status')(h.$)).text;
    const gone = await say();
    expect(gone).toContain('/ariadne-connect');
    expect(await say()).toBe(gone);
    expect(h.logs.slice(before)).toHaveLength(1);
    expect(gone).toContain(h.logs[before]);
    code = 'invalid_transition';details = {reason:'owner_paused'};
    expect(await say()).toContain('paused in the app. Resume it in Ariadne');
    code = 'delivery_uncertain';details = undefined;
    expect(await say()).toContain('check before sending anything again');
    code = 'invented_by_a_future_helper';
    expect(await say()).toContain('Open the Ariadne app to see what happened');
    expect(h.logs.slice(before)).toHaveLength(4);
    expect(h.logs.slice(before).join(' ')).not.toMatch(/stale_generation|owner_paused|delivery_uncertain|invented|retain|original IDs/);
  });
  it('admits claims again after an owner command is refused', async () => {
    const value = await prepared();const submission = deferred();
    const h = host({claim:value,submit:() => submission.promise});const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    await h.timer().callback();
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    expect((await hooks.get('ariadne-connect')(h.$)).text).toContain('still answering');
    expect(JSON.parse((await hooks.get('ariadne-status')(h.$)).text).local.admission_open).toBe(true);
    submission.resolve({text:value.formatted_payload});
    await hooks.get('turn.start')(h.$,{text:value.formatted_payload,turnId:'turn'},next);
    await hooks.get('turn.complete')(h.$,{turnId:'turn',answer:'done',reason:'answer',isAborted:false},next);
    await vi.waitFor(() => expect(h.events.at(-1).kind).toBe('turn_finished'));
    await h.timer().callback();
    await vi.waitFor(() => expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(2));
  });
});
