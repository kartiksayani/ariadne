import { describe, it, expect } from 'vitest';
import { createRegister } from '../../../integrations/claude/plugin/hooks/register.js';
import { capabilities, deferred, descriptor, failure, host, ids, prepared, success } from './fixtures.js';
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
      expect(retried.text).toContain('connection connected');
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
    expect(unsupported.logs.some(log => log.includes('unsupported'))).toBe(true);
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
    const [summary,...guidance] = result.text.split('\n');
    expect(summary).toContain(`session ${ids.session} in project ${ids.project}`);
    expect(summary).toContain(`binding ${ids.binding}, generation ${ids.generation}`);
    expect(summary).toContain('[ARIADNE_INPUT:');
    expect(result.text).toContain('without waiting for an input');
    expect(result.text).toContain('Never edit .ariadne/');
    expect(result.text).not.toContain('Use published Ariadne domain commands.');
    expect(result.text).not.toContain('"instruction"');
    expect(guidance.join('\n')).toContain(`project ${ids.project}, session ${ids.session}`);
    expect(guidance.join('\n')).toContain('respect cancelled work');
    expect(h.calls.filter(call => call.argv[1] === 'binding').map(call => JSON.parse(call.options.stdin).command.params.existing_session_id)).toEqual([ids.session]);
    expect(h.prompts).toEqual([]);
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
    expect(result.text).toMatch(/^Ariadne connected: session /);
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
    expect((await hooks.get('ariadne-connect')(h.$)).text).toContain('recovery_required');
    expect((await hooks.get('ariadne-disconnect')(h.$)).text).toContain('recovery_required');
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
    expect((await hooks.get('ariadne-connect')(h.$)).text).toContain('in progress');
    expect((await hooks.get('ariadne-disconnect')(h.$)).text).toContain('in progress');
    expect(connects).toBe(2);
    receipt.resolve();await reconnect;h.timer().callback();await submitted.promise;
    await hooks.get('turn.start')(h.$,{text:value.formatted_payload,turnId:'retained-turn'},next);
    expect(h.events.map(event => event.kind)).toEqual(['accepted','turn_started']);
    expect(h.events.every(event => event.attempt_id === ids.attempt)).toBe(true);
    submission.resolve({text:value.formatted_payload});
    await hooks.get('session.end')(h.$,{},next);
  });
  it('drains a late durable claim and retains its old scope and failed report before rejecting rotation', async () => {
    const entered = deferred(), claim = deferred();const value = await prepared();
    const h = host({handler:async argv => {
      if (argv[2] === 'claim') {entered.resolve();return claim.promise;}
      if (argv[2] === 'report') return failure('commit_uncertain');
    }});const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    h.timer().callback();await entered.promise;
    const reconnect = hooks.get('ariadne-connect')(h.$);
    expect(h.calls.filter(call => call.argv[1] === 'binding')).toHaveLength(1);
    claim.resolve({exitCode:0,stdout:JSON.stringify({api_version:1,ok:true,data:value}),stderr:''});
    expect((await reconnect).text).toContain('recovery_required');
    const local = JSON.parse((await hooks.get('ariadne-status')(h.$)).text).local;
    expect(local.active).toEqual({input_id:ids.input,attempt_id:ids.attempt,host_turn_id:null});
    expect(local.pending_reports).toBe(1);expect(local.admission_open).toBe(false);
    expect(h.prompts).toEqual([]);
    const reports = h.calls.filter(call => call.argv[2] === 'report');
    const retained = reports[0].options.stdin;
    expect(JSON.parse(retained)).toMatchObject({binding_id:ids.binding,generation:ids.generation,attempt_id:ids.attempt,kind:'uncertain'});
    expect((await hooks.get('ariadne-disconnect')(h.$)).text).toContain('recovery_required');
    h.timer().callback();await hooks.get('session.end')(h.$,{},next);
    expect(h.calls.filter(call => call.argv[2] === 'report').every(call => call.options.stdin === retained)).toBe(true);
    expect(h.calls.filter(call => call.argv[1] === 'binding')).toHaveLength(1);
  });
  it('retains an uncertain claim request ID and cannot turn quiescence into a fresh claim', async () => {
    const entered = deferred(), claim = deferred();
    const h = host({handler:async argv => {if (argv[2] === 'claim') {entered.resolve();return claim.promise;}}});
    const hooks = callbacks(descriptor);
    await hooks.get('session.start')(h.$,{},next);await hooks.get('ariadne-connect')(h.$);
    h.timer().callback();await entered.promise;
    const reconnect = hooks.get('ariadne-connect')(h.$);claim.resolve(failure('delivery_uncertain'));
    expect((await reconnect).text).toContain('recovery_required');
    const original = h.calls.find(call => call.argv[2] === 'claim').argv.at(-1);
    const local = JSON.parse((await hooks.get('ariadne-status')(h.$)).text).local;
    expect(local.pending_claim_request_id).toBe(original);expect(local.admission_open).toBe(false);
    h.timer().callback();await hooks.get('session.end')(h.$,{},next);
    expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(1);expect(h.prompts).toEqual([]);
  });
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
    expect(local.active).toBe(null);expect(local.admission_open).toBe(false);
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
    expect((await hooks.get('ariadne-connect')(h.$)).text).toContain('session ended');
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
    expect((await reconnect).text).toContain('late original-scope evidence');
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
    expect((await reconnect).text).toContain('late original-scope evidence');
    report.resolve(failure('protocol_conflict'));await callback;
    const local = JSON.parse((await hooks.get('ariadne-status')(h.$)).text).local;
    expect(local.pending_reports).toBe(1);expect(local.admission_open).toBe(false);expect(local.paused).toBe(true);
    const retained = h.calls.filter(call => call.argv[2] === 'report').at(-1).options.stdin;
    expect(JSON.parse(retained)).toMatchObject({generation:ids.generation,attempt_id:ids.attempt,host_turn_id:'original-turn',payload:{diagnostic_text:'changed'}});
    h.timer().callback();await hooks.get('session.end')(h.$,{},next);
    expect(h.calls.filter(call => call.argv[2] === 'claim')).toHaveLength(1);expect(h.prompts).toHaveLength(1);
  });

});
