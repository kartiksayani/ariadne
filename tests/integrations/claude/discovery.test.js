import { describe, it, expect } from 'vitest';
import { announcements } from '../../../integrations/claude/plugin/hooks/discovery.js';
import { binding, deferred, descriptor, failure, host, success } from './fixtures.js';

function loaded(options = {}) {
  const h = host({handler:(argv,options) => {
    if (argv[2] === 'announce') {
      const body = JSON.parse(options.stdin);
      return success({adapter_id:body.adapter_id,external_session_id:body.external_session_id});
    }
  },...options});
  // Actual supported SDK shape: no imaginary $.plugin.version or own register capture.
  h.$.plugin = {name:'ariadne',root:'/installed/ariadne/0.1.0'};
  return h;
}
describe('private read-only SDK announcement producer', () => {
  it('uses actual loaded root/descriptor and original SDK identity without claiming compatibility', async () => {
    const h = loaded({version:'2.1.289'});
    const a = announcements(descriptor);
    expect(await a.announce(h.$)).toBe(true);
    const call = h.calls[0];
    expect(call.argv.slice(0,4)).toEqual([descriptor.helperPath,'bridge','announce','--request-id']);
    expect(call.argv[4]).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.argv[5]).toBe('--json-stdin');
    expect(call.options.timeoutMs).toBe(5000);
    expect(JSON.parse(call.options.stdin)).toEqual({adapter_id:'claude_code_mod',external_session_id:binding.external_session_id,
      cwd:'/project/original',host_version:'2.1.289',plugin:h.$.plugin,descriptor,binding_scope:null});
    expect(h.prompts).toEqual([]);
    expect(h.events).toEqual([]);
    expect(await a.announce(h.$,{binding_id:binding.binding_id,generation:binding.generation})).toBe(true);
    expect(JSON.parse(h.calls[1].options.stdin).binding_scope).toEqual({binding_id:binding.binding_id,generation:binding.generation});
    expect(h.calls[1].argv[4]).not.toBe(call.argv[4]);
  });
  it('never uses PATH or guessed plugin/cache roots when installed or SDK inputs are missing', async () => {
    for (const config of [null,{...descriptor,helperPath:'ariadne'},{...descriptor,helperPath:'/tmp/../ariadne'}, {...descriptor,apiVersion:2}]) {
      const h = loaded();
      await expect(announcements(config).announce(h.$)).rejects.toThrow('descriptor');
      expect(h.calls).toEqual([]);
    }
    for (const plugin of [{version:'0.1.0'},{name:'different',root:'/installed'},{name:'ariadne',root:'relative'}]) {
      const h = loaded();h.$.plugin=plugin;
      await expect(announcements(descriptor).announce(h.$)).rejects.toThrow('loaded Ariadne plugin');
      expect(h.calls).toEqual([]);
    }
  });
  it('rejects overbound metadata and changed session/project before invoking the helper', async () => {
    const h = loaded();h.$.session.id=async () => '😀'.repeat(1025);
    await expect(announcements(descriptor).announce(h.$)).rejects.toThrow('bounded original');
    expect(h.calls).toEqual([]);
    let reads=0;
    const changed = loaded();changed.$.session.id=async () => ++reads === 1 ? 'original' : 'another';
    await expect(announcements(descriptor).announce(changed.$)).rejects.toThrow('changed');
    expect(changed.calls).toEqual([]);
    const scope = loaded();
    await expect(announcements(descriptor).announce(scope.$,{binding_id:binding.binding_id,generation:'inferred'})).rejects.toThrow('original validated');
    expect(scope.calls).toEqual([]);
  });
  it('coalesces in-flight ticks and stopping prevents a captured-but-unsubmitted heartbeat', async () => {
    const entered=deferred(), reply=deferred();
    const h = loaded({handler:async argv => {
      if (argv[2] === 'announce') {entered.resolve();return reply.promise;}
    }});
    const a=announcements(descriptor), first=a.announce(h.$);
    await entered.promise;
    expect(await a.announce(h.$)).toBe(false);
    a.stop();reply.resolve(success({adapter_id:'claude_code_mod',external_session_id:binding.external_session_id}));
    expect(await first).toBe(true);
    expect(await a.announce(h.$)).toBe(false);
    expect(h.calls).toHaveLength(1);
    const read=deferred(), captured=deferred(), late=loaded();
    late.$.session.id=async () => {captured.resolve();await read.promise;return binding.external_session_id;};
    const stopped=announcements(descriptor), pending=stopped.announce(late.$);
    await captured.promise;stopped.stop();read.resolve();
    expect(await pending).toBe(false);
    expect(late.calls).toEqual([]);
  });
  it('rejects unsupported/malformed/foreign acknowledgements and retains no authority', async () => {
    for (const result of [failure('unsupported'),success({adapter_id:'codex',external_session_id:binding.external_session_id}),
      success({adapter_id:'claude_code_mod',external_session_id:'another'}),
      success({adapter_id:'claude_code_mod',external_session_id:binding.external_session_id,connected:true})]) {
      const h=loaded({handler:() => result});
      await expect(announcements(descriptor).announce(h.$)).rejects.toThrow();
      expect(h.calls).toHaveLength(1);
      expect(h.events).toEqual([]);expect(h.prompts).toEqual([]);
    }
  });
});
