import assert from 'node:assert/strict';
// Run with both the standalone Node command and the existing coverage suite.
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
import { createRegister } from '../../../integrations/claude/plugin/hooks/register.js';
import { setup } from '../../../integrations/claude/plugin/hooks/setup.js';
import { capabilities, descriptor, failure, host, ids, status, success } from './fixtures.js';

function hooks() {
  const callbacks = new Map();
  createRegister(descriptor,{waitMs:0,pollMs:0})((name,pattern,handler) => {
    if (typeof pattern === 'function') {handler=pattern;pattern=null;}
    callbacks.set(pattern?.command ?? name,handler);
  });
  return callbacks;
}
const next = async event => event;
const mutations = h => h.calls.filter(call => call.argv[2] === 'connect' && !call.argv.includes('--replay-only'));
function receipt(request, session = ids.session, generation = ids.generation) {
  return success({operation_id:request.command.op_id,session_id:session,revision:2,
    data:{kind:'binding_connect',binding_id:ids.binding,generation,capabilities:capabilities(),setup_instruction:'Use Ariadne commands.'}});
}
function plain(text) {
  assert.doesNotMatch(text,/\b(binding|claim|retain|registered|revision|target|operation|generation|UUID)\b|[0-9a-f]{8}-[0-9a-f]{4}-/i);
}

for (const gone of ['missing','disconnected','replaced']) {
  test(`resumed conversation recovers an unconfirmed fetch after the app ${gone} the connection`, async () => {
    let lost = false, generation = ids.generation;
    const h = host({handler:(argv,options) => {
      if (argv[2] === 'connect' && !argv.includes('--replay-only')) {
        if (lost) {generation=ids.attempt;lost=false;}
        return receipt(JSON.parse(options.stdin),ids.session,generation);
      }
      if (argv[2] === 'claim') return lost ? failure('not_found',{reason:'lease_invalid'}) : failure('delivery_uncertain');
      if (argv[2] === 'connection-status') {
        if (lost && gone === 'missing') return failure('not_found',{reason:'lease_invalid'});
        if (lost && gone === 'replaced') return failure('stale_generation');
        return success({...status,generation,connection_state:lost ? 'disconnected' : 'connected'});
      }
    }});
    const commands = hooks();
    await commands.get('session.start')(h.$,{},next);
    await commands.get('ariadne-connect')(h.$,{args:ids.session});
    h.timer().callback();
    // The timer is detached; wait for the retained request to become observable.
    for (let i = 0; i < 20; i += 1) {
      await new Promise(resolve => setTimeout(resolve,0));
      const local = JSON.parse((await commands.get('ariadne-status')(h.$)).text).local;
      if (local.pending_claim_request_id) break;
    }
    lost = true;
    const result = await commands.get('ariadne-connect')(h.$,{args:ids.session});
    assert.match(result.text,/connected to Ariadne/);
    plain(result.text);
    assert.equal(mutations(h).length,2);
    const requests = h.calls.filter(call => call.argv[2] === 'claim').map(call => call.argv.at(-1));
    assert.equal(requests.length,2);
    assert.equal(requests[0],requests[1]);
    assert.deepEqual(h.prompts,[]);
    assert.ok(h.logs.every(text => !text.includes('app is open')));
  });
}

test('a different requested session discards an uncommitted old request', async () => {
  let timedOut = true;
  const h = host({handler:(argv,options) => {
    if (argv.includes('--replay-only')) return success(null);
    if (argv[2] === 'connect') {
      if (timedOut) {timedOut=false;throw new Error('SDK timeout');}
      return receipt(JSON.parse(options.stdin),ids.input);
    }
  }});
  const owner = setup(descriptor.helperPath);
  await assert.rejects(owner.connect(h.$,ids.session),/timeout/);
  await owner.connect(h.$,ids.input);
  const [before,after] = mutations(h).map(call => JSON.parse(call.options.stdin).command);
  assert.notEqual(before.op_id,after.op_id);
  assert.equal(after.params.existing_session_id,ids.input);
  assert.equal(h.calls.find(call => call.argv.includes('--replay-only')).options.stdin,mutations(h)[0].options.stdin);
});

test('reloaded hooks recover an automatic reconnect for a different session', async () => {
  const store = new Map([['binding:original-host-session',{project_id:ids.project,session_id:ids.session,saved_at:new Date().toISOString()}]]);
  let lost = true;
  const h = host({store,handler:(argv,options) => {
    if (argv.includes('--replay-only')) return success(null);
    if (argv[2] === 'connect') {
      if (lost) {lost=false;throw new Error('SDK timeout');}
      return receipt(JSON.parse(options.stdin),ids.input);
    }
  }});
  const reloaded = hooks();
  await reloaded.get('session.start')(h.$,{},next);
  for (let i = 0; i < 20 && !h.logs.some(text => text.includes('reconnect')); i += 1) await new Promise(resolve => setTimeout(resolve,0));
  const result = await reloaded.get('ariadne-connect')(h.$,{args:ids.input});
  assert.match(result.text,/connected to Ariadne/);
  plain(result.text);
  assert.equal(mutations(h).length,2);
  const [old,fresh] = mutations(h).map(call => JSON.parse(call.options.stdin).command);
  assert.equal(old.params.existing_session_id,ids.session);
  assert.equal(fresh.params.existing_session_id,ids.input);
  assert.notEqual(old.op_id,fresh.op_id);
  assert.equal(store.get('binding:original-host-session').session_id,ids.input);
});

test('a committed obsolete request is checked with the app before connecting the chosen session', async () => {
  let missing = true;
  const h = host({handler:(argv,options) => {
    if (argv[2] === 'connect' && !argv.includes('--replay-only')) return receipt(JSON.parse(options.stdin),JSON.parse(options.stdin).command.params.existing_session_id);
    if (argv[2] === 'connection-status' && missing) return failure('not_found',{reason:'lease_invalid'});
  }});
  const owner = setup(descriptor.helperPath,undefined,{waitMs:0,pollMs:0});
  await assert.rejects(owner.connect(h.$,ids.session));
  missing = false;
  await owner.connect(h.$,ids.input);
  const calls = h.calls;
  const lookup = calls.findIndex(call => call.argv.includes('--replay-only'));
  assert.equal(calls[lookup + 1].argv[2],'connection-status');
  assert.equal(calls[lookup + 2].argv[2],'connect');
  assert.notEqual(JSON.parse(mutations(h)[0].options.stdin).command.op_id,JSON.parse(mutations(h)[1].options.stdin).command.op_id);
});

test('an unchanged timeout retry uses exactly the same request and remains idempotent', async () => {
  let timedOut = true;
  const h = host({handler:argv => {
    if (argv[2] === 'connect' && !argv.includes('--replay-only') && timedOut) {timedOut=false;throw new Error('SDK timeout');}
  }});
  const owner = setup(descriptor.helperPath);
  await assert.rejects(owner.connect(h.$,ids.session));
  const result = await owner.connect(h.$,ids.session);
  assert.equal(result.binding.session.session_id,ids.session);
  assert.equal(mutations(h)[0].options.stdin,mutations(h)[1].options.stdin);
  const log = h.store.get('connect-log');
  assert.equal(log.at(-1).operation_id,JSON.parse(mutations(h)[0].options.stdin).command.op_id);
});

test('a saved connection awaiting publication retries the exact same operation after timeout', async () => {
  let missing = true;
  const h = host({handler:argv => argv[2] === 'connection-status' && missing ? failure('not_found',{reason:'lease_invalid'}) : undefined});
  const owner = setup(descriptor.helperPath,undefined,{waitMs:0,pollMs:0});
  await assert.rejects(owner.connect(h.$,ids.session));
  await assert.rejects(owner.connect(h.$,ids.session));
  missing = false;
  await owner.connect(h.$,ids.session);
  const requests = mutations(h).map(call => call.options.stdin);
  assert.equal(requests.length,3);
  assert.ok(requests.every(request => request === requests[0]));
  assert.equal(owner.current().generation,ids.generation);
});

test('a live connection in another conversation is refused with a useful next step', async () => {
  const h = host({handler:argv => argv[2] === 'connect' ? failure('binding_conflict') : undefined});
  const result = await hooks().get('ariadne-connect')(h.$,{args:ids.session});
  assert.match(result.text,/disconnect its current conversation before trying again/);
  assert.match(result.text,/start another Claude conversation, then run \/ariadne-connect there/);
  plain(result.text);
  assert.deepEqual(h.prompts,[]);
});

test('a previously saved conversation cannot move sessions silently and gets a way forward', async () => {
  let missing = true;
  const h = host({handler:(argv,options) => {
    if (argv[2] === 'connect' && !argv.includes('--replay-only')) {
      const request = JSON.parse(options.stdin);
      return request.command.params.existing_session_id === ids.session ? receipt(request) : failure('binding_conflict');
    }
    if (argv[2] === 'connection-status' && missing) return failure('not_found',{reason:'lease_invalid'});
  }});
  const commands = hooks();
  await commands.get('ariadne-connect')(h.$,{args:ids.session});
  missing = false;
  const result = await commands.get('ariadne-connect')(h.$,{args:ids.input});
  assert.match(result.text,/start another Claude conversation, then run \/ariadne-connect there/);
  plain(result.text);
  assert.equal(mutations(h).length,2);
  assert.notEqual(mutations(h)[0].options.stdin,mutations(h)[1].options.stdin);
  assert.deepEqual(h.prompts,[]);
});

test('a truly unreachable app gives the exact open-app instruction', async () => {
  const h = host({handler:argv => argv[1] === '--version' ? undefined : failure('host_unreachable')});
  const result = await hooks().get('ariadne-connect')(h.$,{args:ids.session});
  assert.equal(result.text,'That did not complete. Open the Ariadne app, then run /ariadne-connect again.');
  plain(result.text);
  assert.deepEqual(h.prompts,[]);
});

test('unknown helper rejection never leaks diagnostics or operation jargon', async () => {
  const h = host({handler:argv => argv[2] === 'connect' ? success({operation_id:ids.input}) : undefined});
  const result = await hooks().get('ariadne-connect')(h.$,{args:ids.session});
  assert.match(result.text,/Run \/ariadne-connect again/);
  plain(result.text);
  h.logs.forEach(plain);
});

test('an SDK rejection cannot provide owner-visible text', async () => {
  for (const phase of ['connect','connection-status']) {
    const h = host({handler:argv => {
      if (argv[2] === phase) throw {code:'host_unreachable',plain:`retain binding ${ids.binding}`,message:'untrusted SDK rejection'};
    }});
    const result = await hooks().get('ariadne-connect')(h.$,{args:ids.session});
    assert.match(result.text,/Run \/ariadne-connect again/);
    plain(result.text);
    h.logs.forEach(plain);
  }
});
