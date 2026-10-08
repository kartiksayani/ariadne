import { readFileSync } from 'node:fs';
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
    expect(result).not.toHaveProperty('instruction');
    expect(h.prompts).toEqual([]);
  });
  it('accepts the shipped setup instruction and refuses one past the core limit', async () => {
    const shipped = readFileSync(new URL('../../../integrations/claude/plugin/skills/ariadne/SKILL.md', import.meta.url), 'utf8')
      + `\n\nUse these routing IDs for Ariadne commands: binding ${ids.binding}, generation ${ids.generation}.`;
    expect(Buffer.byteLength(shipped)).toBeGreaterThan(4096);
    const connectWith = async instruction => {
      const h = host({handler:(argv,options) => argv[1] === 'binding' && argv[2] === 'connect' ? success({operation_id:JSON.parse(options.stdin).command.op_id,
        session_id:ids.session,revision:2,data:{kind:'binding_connect',binding_id:ids.binding,generation:ids.generation,
          capabilities:capabilities(),setup_instruction:instruction}}) : undefined});
      return setup(descriptor.helperPath).connect(h.$);
    };
    expect((await connectWith(shipped)).binding.binding_id).toBe(ids.binding);
    await expect(connectWith('x'.repeat(64 * 1024 + 1))).rejects.toThrow('exact canonical saved receipt');
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
    for (const version of ['2.1.288','2.1.289','2.1.1000','2.2.0','2.2.287','3.0.0','3.1.287','10.0.0']) await qualify(host({version}).$,descriptor);
    for (const version of ['2.1.286','2.0.999','1.99.999','1.1.287','2.1','2.1.287.1','2.1.x','','garbage',null,2.1,'2.1.0','1.1.287','2.1.-1','2.1.+300','2.1.287-beta','2..300',' 2.1.300','2.1.300 ','2.1.300\n','2.1.99999999999999999999','02.1.287','2.01.287','2.1.0288','2.1.00']) {
      await expect(qualify(host({version}).$,descriptor)).rejects.toThrow('requires Claude Code 2.1.287 or newer');
    }
    await expect(qualify(h.$,null)).rejects.toThrow('descriptor');
    const mismatch = host({handler:() => ({exitCode:0,stdout:'ariadne 0.2.0\n'})});
    await expect(qualify(mismatch.$,descriptor)).rejects.toThrow('versions disagree');
  });
  it('waits for the app to publish the binding route while status reports not_found', async () => {
    let polls = 0;
    const h = host({handler:argv => {
      if (argv[2] === 'connection-status' && ++polls <= 2) return failure('not_found');
    }});
    const result = await setup(descriptor.helperPath,undefined,{waitMs:2000,pollMs:1}).connect(h.$);
    expect(result.binding.binding_id).toBe(ids.binding);
    expect(result.status).toEqual(status);
    expect(h.calls.filter(call => call.argv[2] === 'connection-status')).toHaveLength(3);
  });
  it('reports pending status after the publish wait elapses on persistent not_found', async () => {
    const h = host({handler:argv => argv[2] === 'connection-status' ? failure('not_found') : undefined});
    await expect(setup(descriptor.helperPath,undefined,{waitMs:5,pollMs:1}).connect(h.$))
      .rejects.toThrow(/connection status remains pending[\s\S]*\(not_found\)/);
    expect(h.calls.filter(call => call.argv[2] === 'connection-status').length).toBeGreaterThan(1);
  });
  it('does not retry connection status errors other than not_found', async () => {
    const h = host({handler:argv => argv[2] === 'connection-status' ? failure('host_unreachable') : undefined});
    await expect(setup(descriptor.helperPath,undefined,{waitMs:2000,pollMs:1}).connect(h.$))
      .rejects.toThrow('host_unreachable');
    expect(h.calls.filter(call => call.argv[2] === 'connection-status')).toHaveLength(1);
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
  it('forget drops the old conversation and its pending connect so a new conversation can connect', async () => {
    let failing = true;
    const h = host({handler:argv => argv[1] === 'binding' && failing ? failure('commit_uncertain') : undefined});
    const owner = setup(descriptor.helperPath);
    await expect(owner.connect(h.$,ids.session)).rejects.toThrow('commit_uncertain');
    h.switchSession('conversation-after-clear');
    await expect(owner.connect(h.$,ids.session)).rejects.toThrow('changed with a pending');
    owner.forget();failing = false;
    const before = h.calls.length;
    // Status is read for the new conversation.
    const statusFor = host({handler:argv => argv[2] === 'connection-status'
      ? success({...status,external_session_id:'conversation-after-clear'}) : undefined});
    statusFor.switchSession('conversation-after-clear');
    const {binding} = await owner.connect(statusFor.$,ids.session);
    expect(binding.external_session_id).toBe('conversation-after-clear');
    expect(owner.current()).toEqual(binding);
    expect(JSON.parse(statusFor.calls.find(call => call.argv[1] === 'binding').options.stdin).command.params)
      .toMatchObject({external_session_id:'conversation-after-clear',existing_session_id:ids.session});
    expect(h.calls).toHaveLength(before);
    owner.forget();expect(owner.current()).toBe(null);
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
