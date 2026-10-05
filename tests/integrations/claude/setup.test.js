import { describe, it, expect } from 'vitest';
import { bindingStatus, qualify, setup } from '../../../integrations/claude/plugin/hooks/setup.js';
import { descriptor, failure, host, ids, status, success, capabilities } from './fixtures.js';

describe('installed owner helper setup', () => {
  it('explicitly targets an existing session and retains its exact operation through uncertainty', async () => {
    let failing = true;
    const h = host({handler:argv => argv[1] === 'binding' && failing ? failure('commit_uncertain') : undefined});
    const owner = setup(descriptor.helperPath);
    await expect(owner.connect(h.$,ids.session)).rejects.toThrow('commit_uncertain');
    const original = h.calls.at(-1).options.stdin;
    expect(JSON.parse(original)).toMatchObject({session:null,command:{params:{project_id:ids.project,existing_session_id:ids.session}}});
    await expect(owner.connect(h.$,ids.input)).rejects.toThrow('different session');
    await expect(owner.connect(h.$)).rejects.toThrow('different session');
    expect(h.calls.at(-1).options.stdin).toBe(original);
    failing = false;
    const result = await owner.connect(h.$,ids.session);
    expect(h.calls.filter(call => call.argv[1] === 'binding').map(call => call.options.stdin)).toEqual([original,original]);
    expect(result.binding.session).toEqual({project_id:ids.project,session_id:ids.session});
    expect(result.instruction).toBe('Use published Ariadne domain commands.');
    expect(h.prompts).toEqual([]);
  });
  it('rejects an explicit-target receipt mismatch before status, preserving the pending body', async () => {
    const h = host({handler:(argv,options) => argv[1] === 'binding' ? success({operation_id:JSON.parse(options.stdin).command.op_id,
      session_id:ids.input,revision:2,data:{kind:'binding_connect',binding_id:ids.binding,generation:ids.generation,
        capabilities:capabilities(),setup_instruction:'Exact canonical instruction.'}}) : undefined});
    const owner = setup(descriptor.helperPath);
    await expect(owner.connect(h.$,ids.session)).rejects.toThrow('differs from the explicit');
    await expect(owner.connect(h.$,ids.session)).rejects.toThrow('differs from the explicit');
    expect(h.calls.filter(call => call.argv[1] === 'binding').map(call => call.options.stdin)).toEqual([h.calls[1].options.stdin,h.calls[1].options.stdin]);
    expect(h.calls.some(call => call.argv[2] === 'connection-status')).toBe(false);
    await expect(owner.status(h.$)).rejects.toThrow('ariadne-connect');
    await expect(owner.connect(h.$,'not-a-uuid')).rejects.toThrow('canonical Ariadne session UUID');
  });
  it('qualifies exact supported host and helper version before owner mutation/polling', async () => {
    const h = host();await qualify(h.$,descriptor);
    expect(h.calls[0]).toEqual({argv:[descriptor.helperPath,'--version'],options:{timeoutMs:5000}});
    for (const version of ['2.1.288','2.1.289','2.1.1000']) await qualify(host({version}).$,descriptor);
    for (const version of ['2.1.286','2.2.287','2.0.999','3.1.287','2.1','2.1.287.1','2.1.x','','garbage',null,2.1]) {
      await expect(qualify(host({version}).$,descriptor)).rejects.toThrow('2.1.287');
    }
    await expect(qualify(h.$,null)).rejects.toThrow('descriptor');
    const mismatch = host({handler:() => ({exitCode:0,stdout:'ariadne 0.2.0\n'})});
    await expect(qualify(mismatch.$,descriptor)).rejects.toThrow('versions disagree');
  });
  it('uses canonical bootstrap wrappers and installed fixed provider facts, then validates scoped status', async () => {
    const h = host();const owner = setup(descriptor.helperPath);
    const result = await owner.connect(h.$);
    expect(result.binding.session).toEqual({project_id:ids.project,session_id:ids.session});
    const requests = h.calls.filter(call => call.options.stdin).map(call => JSON.parse(call.options.stdin));
    expect(requests[0]).toEqual({session:null,command:{api_version:1,op_id:expect.any(String),command:'project_register',params:{canonical_root:'/project/original'}}});
    expect(requests[1]).toEqual({session:null,command:{api_version:1,op_id:expect.any(String),command:'binding_connect',params:{project_id:ids.project,adapter_id:'claude_code_mod',external_session_id:'original-host-session',endpoint:{kind:'local_bridge',name:'claude-mod'},configuration:{namespace:'claude_code_mod',values:{}},existing_session_id:null}}});
    expect(h.calls[2].argv.slice(0,3)).toEqual([descriptor.helperPath,'bridge','connection-status']);
    expect(result.status.presence).toBe(null);
    expect(h.calls.some(call => call.argv[2] === 'report')).toBe(false); // No fabricated Connected.
    expect(await owner.status(h.$)).toEqual(status);
    const before = h.calls.at(-2).argv.at(-1), after = h.calls.at(-1).argv.at(-1);
    expect(before).not.toBe(after);
  });
  it('retains exact operation body/UUID on lost registration/connect receipt and never retargets a pending operation', async () => {
    let failing = true;
    const h = host({handler:argv => argv[1] === 'binding' && failing ? failure('commit_uncertain') : undefined});
    const owner = setup(descriptor.helperPath);
    await expect(owner.connect(h.$)).rejects.toThrow('commit_uncertain');
    failing = false;await owner.connect(h.$);
    const connect = h.calls.filter(call => call.argv[1] === 'binding');
    expect(connect[0].options.stdin).toBe(connect[1].options.stdin);
    expect(h.calls.filter(call => call.argv[1] === 'project')).toHaveLength(1);
    const other = host({handler:argv => argv[1] === 'project' ? failure() : undefined});
    const pending = setup(descriptor.helperPath);await expect(pending.connect(other.$)).rejects.toThrow();
    other.$.session.cwd = async () => '/different-project';
    await expect(pending.connect(other.$)).rejects.toThrow('changed with a pending');
    expect(other.calls).toHaveLength(1);
  });
  it('disconnect uses registered SessionRef, saved receipt, and preserves operation ID across failure', async () => {
    let failDisconnect = true;
    const h = host({handler:argv => argv[2] === 'disconnect' && failDisconnect ? failure() : undefined});
    const owner = setup(descriptor.helperPath);await owner.connect(h.$);
    await expect(owner.disconnect(h.$)).rejects.toThrow();
    failDisconnect = false;await owner.disconnect(h.$);
    const calls = h.calls.filter(call => call.argv[2] === 'disconnect');
    expect(calls[0].options.stdin).toBe(calls[1].options.stdin);
    const body = JSON.parse(calls[0].options.stdin);
    expect(body.session).toEqual({project_id:ids.project,session_id:ids.session});
    expect(body.command.params).toEqual({binding_id:ids.binding,expected_generation:ids.generation});
    await expect(owner.status(h.$)).rejects.toThrow('ariadne-connect');
    await expect(owner.disconnect(h.$)).rejects.toThrow('No registered');
  });
  it('rejects malformed receipts, changed provider/session/generation, and never creates fake local connection', async () => {
    const h = host({handler:argv => argv[1] === 'project' ? {exitCode:0,stdout:'{"api_version":1,"ok":true,"data":{}}'} : undefined});
    await expect(setup(descriptor.helperPath).connect(h.$)).rejects.toThrow('exact canonical receipt');
    for (const data of [{...status,id:ids.input},{...status,generation:ids.attempt},{...status,external_session_id:'different'},{...status,connection_state:'healthy'},{...status,adapter_id:'codex'}]) {
      expect(() => bindingStatus(data,{binding_id:ids.binding,generation:ids.generation,external_session_id:status.external_session_id})).toThrow();
    }
    const malformed = host({handler:argv => argv[1] === 'binding' ? {exitCode:0,stdout:'{"api_version":1,"ok":true,"data":{}}'} : undefined});
    await expect(setup(descriptor.helperPath).connect(malformed.$)).rejects.toThrow('saved receipt');
  });
});
