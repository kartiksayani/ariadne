import { describe, it, expect } from 'vitest';
import { createRegister } from '../../../integrations/claude/plugin/hooks/register.js';
import { deferred, descriptor, host, prepared } from './fixtures.js';
function callbacks(descriptor) {
  const hooks = new Map();
  createRegister(descriptor)((name, pattern, handler) => {
    if (typeof pattern === 'function') {handler=pattern;pattern=null;}
    hooks.set(pattern?.command ?? name,handler);
  });
  return hooks;
}
const next = async event => event;
describe('supported Mod entry convention', () => {
  it('registers all commands, guarded one-second poll, scoped status/disconnect and session-end timer cancellation', async () => {
    const h = host();const hooks = callbacks(descriptor);
    const start = {kind:'existing-session'};
    expect(await hooks.get('session.start')(h.$,start,next)).toBe(start);
    expect(h.commands.map(command => command.name)).toEqual(['ariadne-connect','ariadne-status','ariadne-disconnect']);
    expect(h.timer().ms).toBe(1000);
    const result = await hooks.get('ariadne-connect')(h.$);
    expect(JSON.parse(result.text).binding.external_session_id).toBe('original-host-session');
    expect(JSON.parse((await hooks.get('ariadne-status')(h.$)).text).binding.connection_state).toBe('connected');
    h.timer().callback();
    // Explicit shutdown drains the in-flight bounded helper operation.
    const event = {kind:'end'};
    expect(await hooks.get('session.end')(h.$,event,next)).toBe(event);
    expect(h.timer().cancelled).toBe(true);
  });
  it('keeps commands actionable with missing/mismatched descriptor/host and never connects or polls', async () => {
    for (const [config,version] of [[null,'2.1.287'],[descriptor,'2.1.289'],[{...descriptor,helperPath:'ariadne'},'2.1.287']]) {
      const h = host({version});const hooks = callbacks(config);
      await hooks.get('session.start')(h.$,{},next);
      expect(h.timer()).toBe(null);expect(h.calls).toEqual([]);
      expect((await hooks.get('ariadne-connect')(h.$)).text).toContain('did not complete');
      expect(h.logs.some(log => log.includes('matching') || log.includes('2.1.287'))).toBe(true);
      expect(h.calls).toEqual([]);
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
});
