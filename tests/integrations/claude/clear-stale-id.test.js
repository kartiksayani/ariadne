// alpha.22 /clear bug, pinned against a small model of the app (not fixtures.host).
// The model follows the app on the points this bug depends on:
// - binding_connect (core bindings/mod.rs:610-700): the same Claude conversation
//   rotates the generation; another Claude conversation is refused with
//   binding_conflict while the active binding is not Disconnected (live_elsewhere).
//   A new or rotated generation is saved 'unknown'.
// - Activation (runtime providers.rs:237-248, activation.rs:418): a generation
//   becomes 'connected', and its route is published, only after a bound
//   announcement from the conversation Claude is really running. Until then
//   status and claim answer not_found/lease_invalid (control/mod.rs:57-73).
// - bridge report is disk-native (cli bridge/native.rs:10-19): it needs no route,
//   only the active binding and its current generation (report.rs:168-197).
//   The session-end event fences a later Connected of its generation (report.rs:510-517).
// Claude Code 2.1.303 (read from its bundle): /clear runs SessionEnd (Mod session.end,
// payload reason/sessionId/resume) before it switches the conversation ID, and does
// not raise Mod session.start afterwards; a tick in between reads the ended ID.
// Tests marked it.fails reproduce the bug: they pass once the fix lands, and then
// must become plain it().
import { describe, it, expect, vi } from 'vitest';
import { createRegister } from '../../../integrations/claude/plugin/hooks/register.js';
import { capabilities, descriptor, failure, success } from './fixtures.js';

const OLD = 'conversation-before-clear', NEW = 'conversation-after-clear';
const uuid = () => globalThis.crypto.randomUUID();

function appModel() {
  const project = uuid(), session = uuid();
  const bindings = new Map();
  const app = {project,session,bindings,active:null,published:new Set(),ended:new Set(),receipts:new Map(),
    connects:[],reports:[],loseNextConnectReply:false,
    // What $.session.id() returns, and the conversation Claude is really running.
    claude:{id:OLD,real:OLD}};
  app.binding = () => bindings.get(app.active);
  function receipt(op, binding) {
    return {operation_id:op,session_id:session,revision:2,
      data:{kind:'binding_connect',binding_id:binding.id,generation:binding.generation,capabilities:capabilities(),setup_instruction:'Use Ariadne.'}};
  }
  function connect(request) {
    const op = request.command.op_id, params = request.command.params;
    app.connects.push(params);
    const old = app.binding();
    // Only connects naming this one Ariadne session are modelled.
    if (params.existing_session_id !== session) throw new Error('Model covers explicit connects to its session only');
    let binding;
    if (old && old.external === params.external_session_id) {
      binding = old;
      binding.generation = uuid();
    } else {
      if (old && old.state !== 'disconnected') return failure('binding_conflict');
      binding = {id:uuid(),external:params.external_session_id};
      binding.generation = uuid();
      bindings.set(binding.id,binding);
      app.active = binding.id;
    }
    binding.state = 'unknown';
    app.receipts.set(op,receipt(op,binding));
    if (app.loseNextConnectReply) {app.loseNextConnectReply = false;return failure('host_unreachable');}
    return success(app.receipts.get(op));
  }
  function current(id, generation) {
    const binding = bindings.get(id);
    return binding && app.active === id && binding.generation === generation ? binding : null;
  }
  function announce(body) {
    const scope = body.binding_scope, binding = scope && current(scope.binding_id,scope.generation);
    if (binding && binding.external === body.external_session_id && body.external_session_id === app.claude.real
      && !app.ended.has(`${binding.id}:${binding.generation}`)) {
      binding.state = 'connected';
      app.published.add(`${binding.id}:${binding.generation}`);
    }
    return success({adapter_id:body.adapter_id,external_session_id:body.external_session_id});
  }
  function routed(id, generation) {
    const binding = bindings.get(id);
    if (!binding) return failure('not_found',{reason:'session_removed'});
    if (!current(id,generation)) return failure('stale_generation');
    if (!app.published.has(`${id}:${generation}`)) return failure('not_found',{reason:'lease_invalid',binding_id:id});
    return null;
  }
  function report(event) {
    const binding = current(event.binding_id,event.generation);
    if (!binding) return failure('stale_generation');
    app.reports.push(event);
    if (event.kind === 'disconnected') {
      binding.state = 'disconnected';
      app.ended.add(`${binding.id}:${binding.generation}`);
      app.published.delete(`${binding.id}:${binding.generation}`);
    }
    return success({event_id:event.event_id,session_id:session,revision:3,durable_effect:true,replayed:false});
  }
  app.run = async (argv, options) => {
    const [, noun, verb] = argv;
    const flag = name => argv[argv.indexOf(name) + 1];
    if (noun === '--version') return {exitCode:0,stdout:'ariadne 0.1.0\n',stderr:''};
    if (noun === 'project') return success({operation_id:JSON.parse(options.stdin).command.op_id,project_id:project,registry_revision:1});
    if (noun === 'binding' && verb === 'connect') {
      const request = JSON.parse(options.stdin);
      if (argv.includes('--replay-only')) return success(app.receipts.get(request.command.op_id) ?? null);
      return connect(request);
    }
    if (noun === 'binding' && verb === 'disconnect') {
      const {binding_id,expected_generation} = JSON.parse(options.stdin).command.params, op = JSON.parse(options.stdin).command.op_id;
      const binding = current(binding_id,expected_generation);
      if (!binding) return failure('stale_generation');
      binding.state = 'disconnected';
      app.published.delete(`${binding.id}:${binding.generation}`);
      return success({operation_id:op,session_id:session,revision:4,data:{kind:'binding_state',binding_id,generation:binding.generation,
        dispatch_state:'disconnected',owner_paused:false,pause_reason:null,connection_state:'disconnected'}});
    }
    if (verb === 'announce') return announce(JSON.parse(options.stdin));
    if (verb === 'connection-status') {
      const id = flag('--binding'), generation = flag('--generation');
      const refused = routed(id,generation);
      if (refused) return refused;
      const binding = bindings.get(id);
      return success({id,generation,adapter_id:'claude_code_mod',external_session_id:binding.external,dispatch_state:'enabled',
        owner_paused:false,pause_reason:null,connection_state:binding.state,presence:null});
    }
    if (verb === 'claim') return routed(flag('--binding'),flag('--generation')) ?? success(null);
    if (verb === 'report') return report(JSON.parse(options.stdin));
    throw new Error(`Unexpected helper argv ${argv.join(' ')}`);
  };
  return app;
}

// One plugin instance (one Claude process load of the plugin). /reload-plugins
// drops an instance and loads another against the same app, Claude and store.
function instance(app, store) {
  const hooks = new Map(), timers = [], logs = [], appended = [];
  createRegister(descriptor,{waitMs:0,pollMs:0})((name, pattern, handler) => {
    if (typeof pattern === 'function') {handler = pattern;pattern = null;}
    hooks.set(pattern?.command ?? name,pattern?.command ? ($,event = {args:''}) => handler($,event) : handler);
  });
  const $ = {
    plugin:{name:'ariadne',root:'/sdk-reported/plugin'},
    session:{id:async () => app.claude.id,cwd:async () => '/project/original',version:async () => ({version:'2.1.287'}),
      append:async args => {appended.push(args);return {uuid:'row'};}},
    ui:{log:text => logs.push(text)},command:{register:async () => {}},
    clock:{every:(ms,callback) => {const timer = {ms,callback,cancelled:false,cancel() {this.cancelled = true;}};timers.push(timer);return timer;}},
    prompt:{submit:async () => ({text:''})},
    store:{get:async key => store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : undefined,set:async (key,value) => {store.set(key,JSON.parse(JSON.stringify(value)));},
      delete:async key => {store.delete(key);},keys:async () => [...store.keys()]},
    process:{run:(argv,options) => app.run(argv,options)},
  };
  const next = async event => event;
  // Older plugins do not return the tick's promise; give its helper calls time to finish.
  const fire = async ms => {
    await Promise.all(timers.filter(timer => timer.ms === ms && !timer.cancelled).map(timer => timer.callback()));
    await new Promise(resolve => setTimeout(resolve,20));
  };
  return {logs,appended,
    start:() => hooks.get('session.start')($,{},next),
    end:reason => hooks.get('session.end')($,{reason},next),
    command:(name, args = '') => hooks.get(name)($,{args}),
    tick:() => fire(1000),
    heartbeat:() => fire(30000)};
}

async function connectedThenCleared(app, plugin) {
  await plugin.start();
  expect((await plugin.command('ariadne-connect',app.session)).text).toContain('connected to Ariadne');
  expect(app.binding()).toMatchObject({external:OLD,state:'connected'});
  // /clear: Claude now runs the new conversation, but $.session.id() still
  // returns the ended one for a moment (owner's report, alpha.21 app).
  app.claude.real = NEW;
  await plugin.end('clear');
  await plugin.tick();
}
const connectsFor = (app, external) => app.connects.filter(params => params.external_session_id === external);
const settled = async (plugin, times = 4) => { for (let i = 0; i < times; i += 1) { await plugin.tick(); await plugin.heartbeat(); } };

describe('/clear while Claude still reports the ended conversation', () => {
  it.fails('(a) never binds the ended conversation again after its end was reported', async () => {
    const app = appModel(), plugin = instance(app,new Map());
    await connectedThenCleared(app,plugin);
    app.claude.id = NEW;
    await settled(plugin);
    // Only the owner's original connect names the ended conversation.
    expect(connectsFor(app,OLD)).toHaveLength(1);
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
  });

  it('(b) when the same plugin instance sees the new id, the dead scope\'s end report saves without a route and the new conversation connects', async () => {
    // Pins current behaviour: the retired loop's session-end report is
    // disk-native, so the stuck state needs more than a stale first tick.
    const app = appModel(), plugin = instance(app,new Map());
    await connectedThenCleared(app,plugin);
    const dead = {...app.binding()};
    expect(dead).toMatchObject({external:OLD,state:'unknown'});
    expect(connectsFor(app,OLD)).toHaveLength(2);
    app.claude.id = NEW;
    await settled(plugin);
    expect(app.ended.has(`${dead.id}:${dead.generation}`)).toBe(true);
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
  });

  it.fails('(c) after /reload-plugins, the new conversation\'s explicit connect is not refused by the dead binding', async () => {
    const app = appModel(), store = new Map(), plugin = instance(app,store);
    await connectedThenCleared(app,plugin);
    expect(app.binding()).toMatchObject({external:OLD,state:'unknown'});
    // /reload-plugins drops the instance with no session.end; the new one reads the new id.
    app.claude.id = NEW;
    const reloaded = instance(app,store);
    await reloaded.start();
    const answer = (await reloaded.command('ariadne-connect',app.session)).text;
    expect(answer).toContain('connected to Ariadne');
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
  });

  it('(c) today: the explicit connect after /reload-plugins gets the generic binding_conflict text until the app disconnects', async () => {
    const app = appModel(), store = new Map(), plugin = instance(app,store);
    await connectedThenCleared(app,plugin);
    app.claude.id = NEW;
    const reloaded = instance(app,store);
    await reloaded.start();
    const answer = (await reloaded.command('ariadne-connect',app.session)).text;
    expect(answer).toMatch(/^That did not complete\. Check this session in Ariadne and disconnect its current conversation/);
    // The plugin's own disconnect knows nothing after the reload.
    expect((await reloaded.command('ariadne-disconnect')).text).toBe('This conversation is not connected to Ariadne.');
    expect(app.binding()).toMatchObject({external:OLD,state:'unknown'});
    // Only the app's Disconnect (owner binding_disconnect) frees the session.
    const dead = app.binding();
    dead.state = 'disconnected';
    expect((await reloaded.command('ariadne-connect',app.session)).text).toContain('connected to Ariadne');
  });

  it.fails('(c) without a reload: a lost connect reply for the ended conversation does not block the new one', async () => {
    // alpha.21 path with no plugin reload: the stale bind is saved but its reply
    // is lost, so no loop holds it; the conversation change then forgets the
    // retained request (setup.js:267-272) and nothing ever reports its end.
    const app = appModel(), plugin = instance(app,new Map());
    await plugin.start();
    await plugin.command('ariadne-connect',app.session);
    app.claude.real = NEW;
    await plugin.end('clear');
    app.loseNextConnectReply = true;
    await plugin.tick();
    expect(app.binding()).toMatchObject({external:OLD,state:'unknown'});
    app.claude.id = NEW;
    await settled(plugin,6);
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
  });
});

describe('same-ID /clear builds stay supported', () => {
  it('reconnects the kept conversation id on the next tick (pinned in register.test.js too)', async () => {
    const app = appModel(), plugin = instance(app,new Map());
    await plugin.start();
    await plugin.command('ariadne-connect',app.session);
    await plugin.end('clear');
    await vi.waitFor(async () => { await plugin.tick(); expect(app.binding()).toMatchObject({external:OLD,state:'connected'}); });
    expect(connectsFor(app,OLD)).toHaveLength(2);
  });
});
