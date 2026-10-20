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
// alpha.22 fix: automatic reconnect never binds the ended ID until a conversation
// shows it runs there (ID change, main-thread turn, heartbeat 5 s or more after the
// end); a stale bind that still happens (slow ID switch, plugin reloaded in that
// moment, lost reply) is ended by its session-end report, never by a disconnect.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createRegister } from '../../../integrations/claude/plugin/hooks/register.js';
import { capabilities, descriptor, failure, success } from './fixtures.js';

afterEach(() => vi.useRealTimers());
const OLD = 'conversation-before-clear', NEW = 'conversation-after-clear';
const CONFLICT = 'That did not complete. Ariadne has this session connected to another Claude conversation, maybe one you cleared. In Ariadne, click the dot by the session name, choose Connection… (or Sending…), then Disconnect. Then run /ariadne-connect here followed by the session ID (Copy session ID in Ariadne).';
const uuid = () => globalThis.crypto.randomUUID();

function appModel() {
  const project = uuid(), session = uuid();
  const bindings = new Map();
  const app = {project,session,bindings,active:null,published:new Set(),ended:new Set(),receipts:new Map(),
    connects:[],reports:[],claims:[],lookups:0,loseNextConnectReply:false,
    // gate: a deferred the next connect waits on before it commits (a send in flight).
    // commitLater: the next connect saves nothing now and answers host_unreachable;
    // app.late() commits it afterwards. lookupFails: replay-only lookups fail.
    // onLookup: runs after each lookup answers.
    gate:null,commitLater:false,late:null,lookupFails:false,onLookup:null,
    // projectGate/lookupGate/statusGate/reportGate/announceGate/claimGate: a deferred the next such call
    // waits on (marked reached when it does). lookupReply: replaces what lookups
    // answer. reportFails: reports answer host_unreachable. removed: the Ariadne
    // session was deleted (connect refuses it; a lookup fails with io_error).
    projectGate:null,lookupGate:null,statusGate:null,reportGate:null,announceGate:null,claimGate:null,lookupReply:null,reportFails:false,removed:false,
    // What $.session.id() returns, and the conversation Claude is really running.
    claude:{id:OLD,real:OLD}};
  app.binding = () => bindings.get(app.active);
  function receipt(op, binding) {
    return {operation_id:op,session_id:session,revision:2,
      data:{kind:'binding_connect',binding_id:binding.id,generation:binding.generation,capabilities:capabilities(),setup_instruction:'Use Ariadne.'}};
  }
  function connect(request) {
    app.connects.push(request.command.params);
    if (app.removed) return failure('not_found',{reason:'session_removed'});
    return commit(request);
  }
  async function gated(name) {
    const gate = app[name];
    if (!gate) return;
    app[name] = null;
    gate.reached = true;
    await gate.promise;
  }
  function commit(request) {
    const op = request.command.op_id, params = request.command.params;
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
    if (noun === 'project') await gated('projectGate');
    if (noun === 'project') return success({operation_id:JSON.parse(options.stdin).command.op_id,project_id:project,registry_revision:1});
    if (noun === 'binding' && verb === 'connect') {
      const request = JSON.parse(options.stdin);
      if (argv.includes('--replay-only')) {
        app.lookups += 1;
        await gated('lookupGate');
        if (app.lookupFails) return failure('host_unreachable');
        if (app.removed) return failure('io_error');
        if (app.lookupReply) return app.lookupReply();
        const answer = success(app.receipts.get(request.command.op_id) ?? null);
        app.onLookup?.(answer);
        return answer;
      }
      if (app.commitLater) {
        app.commitLater = false;
        app.connects.push(request.command.params);
        app.late = () => { app.late = null; return commit(request); };
        return failure('host_unreachable');
      }
      // Without a gate the connect commits at once, even when its call is not awaited.
      if (app.gate) await gated('gate');
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
    if (verb === 'announce') { await gated('announceGate'); return announce(JSON.parse(options.stdin)); }
    if (verb === 'connection-status') {
      await gated('statusGate');
      const id = flag('--binding'), generation = flag('--generation');
      const refused = routed(id,generation);
      if (refused) return refused;
      const binding = bindings.get(id);
      return success({id,generation,adapter_id:'claude_code_mod',external_session_id:binding.external,dispatch_state:'enabled',
        owner_paused:false,pause_reason:null,connection_state:binding.state,presence:null});
    }
    if (verb === 'claim') { await gated('claimGate'); app.claims.push(flag('--generation')); return routed(flag('--binding'),flag('--generation')) ?? success(null); }
    if (verb === 'report') {
      await gated('reportGate');
      if (app.reportFails) return failure('host_unreachable');
      return report(JSON.parse(options.stdin));
    }
    throw new Error(`Unexpected helper argv ${argv.join(' ')}`);
  };
  return app;
}

// One plugin instance (one Claude process load of the plugin). /reload-plugins
// drops an instance and loads another against the same app, Claude and store.
// `step` runs at each await of a connect, before the plugin looks again.
function instance(app, store, publish = {waitMs:0,pollMs:0}, step = undefined) {
  const hooks = new Map(), timers = [], logs = [], appended = [];
  createRegister(descriptor,publish,step)((name, pattern, handler) => {
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
    // store.setGate: a deferred the next conversation-memory write waits on (a slow store write).
    store:{get:async key => store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : undefined,
      set:async (key,value) => {
        const gate = store.setGate;
        if (gate && key.startsWith('binding:')) { store.setGate = null; gate.reached = true; await gate.promise; }
        store.set(key,JSON.parse(JSON.stringify(value)));
      },
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
    end:(reason, sessionId) => hooks.get('session.end')($,sessionId === undefined ? {reason} : {reason,sessionId},next),
    turn:(event = {turnId:'main-turn'}) => hooks.get('turn.start')($,event,next),
    command:(name, args = '') => hooks.get(name)($,{args}),
    tick:() => fire(1000),
    heartbeat:() => fire(30000),
    // A heartbeat whose helper calls may still be waiting (not awaited).
    beat:() => Promise.all(timers.filter(timer => timer.ms === 30000 && !timer.cancelled).map(timer => timer.callback()))};
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
const deferred = () => { let resolve;const promise = new Promise(done => { resolve = done; });return {promise,resolve}; };
const endReports = (app, binding) => app.reports.filter(event => event.kind === 'disconnected' && event.binding_id === binding.id && event.generation === binding.generation);
// Fake only Date: the 5 s hold and the late-commit window read it; helper calls keep real timers.
function clock() { vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(0);return at => vi.setSystemTime(at); }
// Claude switches the ID later than the next heartbeat (5 s or more after the
// end): that heartbeat binds the ended ID. The binding is the dead one.
async function staleHeartbeatBind(app, plugin, setTime) {
  await connectedThenCleared(app,plugin);
  expect(connectsFor(app,OLD)).toHaveLength(1);
  setTime(5000);
  await plugin.heartbeat();
  expect(connectsFor(app,OLD)).toHaveLength(2);
  return {...app.binding()};
}

describe('/clear while Claude still reports the ended conversation', () => {
  it('(a) never binds the ended conversation again after its end was reported', async () => {
    const app = appModel(), plugin = instance(app,new Map());
    await connectedThenCleared(app,plugin);
    app.claude.id = NEW;
    await settled(plugin);
    // Only the owner's original connect names the ended conversation.
    expect(connectsFor(app,OLD)).toHaveLength(1);
    expect(connectsFor(app,NEW)).toHaveLength(1);
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
  });

  it('(a) neither the tick nor a heartbeat inside 5 s of the end binds the ended id', async () => {
    const setTime = clock(), app = appModel(), plugin = instance(app,new Map());
    await connectedThenCleared(app,plugin);
    for (const at of [1000,2000,4999]) { setTime(at); await plugin.tick(); await plugin.heartbeat(); }
    expect(connectsFor(app,OLD)).toHaveLength(1);
    expect(app.binding()).toMatchObject({external:OLD,state:'disconnected'});
  });

  it('(b) id switch slower than the next heartbeat: the dead bind is ended by its session-end report without a route, then the new conversation connects', async () => {
    const setTime = clock(), app = appModel(), plugin = instance(app,new Map());
    const dead = await staleHeartbeatBind(app,plugin,setTime);
    expect(dead).toMatchObject({external:OLD,state:'unknown'});
    app.claude.id = NEW;
    await settled(plugin);
    expect(endReports(app,dead)).toHaveLength(1);
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
    // The dead generation never had a route, so nothing was claimed through it.
    expect(app.claims).not.toContain(dead.generation);
  });

  it('(c) /reload-plugins after the id switched: the new instance connects, nothing stale is left', async () => {
    const app = appModel(), store = new Map(), plugin = instance(app,store);
    await connectedThenCleared(app,plugin);
    expect(app.binding()).toMatchObject({external:OLD,state:'disconnected'});
    // /reload-plugins drops the instance with no session.end; the new one reads the new id.
    app.claude.id = NEW;
    const reloaded = instance(app,store);
    await reloaded.start();
    const answer = (await reloaded.command('ariadne-connect',app.session)).text;
    expect(answer).toContain('connected to Ariadne');
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
    expect(connectsFor(app,OLD)).toHaveLength(1);
  });

  it('(c) /reload-plugins before the id switched: the new instance may bind the ended id, then ends it on the switch and connects', async () => {
    const app = appModel(), store = new Map(), plugin = instance(app,store);
    await connectedThenCleared(app,plugin);
    // The reloaded instance has no ended id; it reconnects the remembered conversation.
    const reloaded = instance(app,store);
    await reloaded.start();
    await vi.waitFor(() => expect(connectsFor(app,OLD)).toHaveLength(2));
    const dead = {...app.binding()};
    expect(dead).toMatchObject({external:OLD,state:'unknown'});
    app.claude.id = NEW;
    await settled(reloaded);
    expect(endReports(app,dead)).toHaveLength(1);
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
    expect(connectsFor(app,NEW)).toHaveLength(1);
  });

  it('(c) a dead binding left by an older plugin: one plain step, then the app\'s Disconnect frees the session', async () => {
    const app = appModel(), store = new Map(), plugin = instance(app,store);
    await connectedThenCleared(app,plugin);
    // What an alpha.21 plugin's stale tick left: the ended conversation bound again, never announced.
    app.run(['helper','binding','connect'],{stdin:JSON.stringify({session:null,command:{op_id:uuid(),params:{...app.connects[0]}}})});
    expect(app.binding()).toMatchObject({external:OLD,state:'unknown'});
    app.claude.id = NEW;
    const reloaded = instance(app,store);
    await reloaded.start();
    expect((await reloaded.command('ariadne-connect',app.session)).text).toBe(CONFLICT);
    // The plugin's own disconnect knows nothing after the reload, and says so.
    expect((await reloaded.command('ariadne-disconnect')).text).toBe("This conversation's connection isn't known here (the plugin may have been reloaded). If Ariadne still shows this session connected, choose Disconnect on it in Ariadne.");
    expect(app.binding()).toMatchObject({external:OLD,state:'unknown'});
    // The app's Disconnect (owner binding_disconnect) frees the session.
    app.binding().state = 'disconnected';
    expect((await reloaded.command('ariadne-connect',app.session)).text).toContain('connected to Ariadne');
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
  });

  it('(c) without a reload: a lost connect reply for the ended conversation does not block the new one', async () => {
    // The stale bind is saved but its reply is lost, so no loop holds it. The
    // conversation change hands the kept request back; its lookup finds the
    // binding and its session-end report frees the session.
    const setTime = clock(), app = appModel(), plugin = instance(app,new Map());
    await connectedThenCleared(app,plugin);
    app.loseNextConnectReply = true;
    setTime(5000);
    await plugin.heartbeat();
    const dead = {...app.binding()};
    expect(dead).toMatchObject({external:OLD,state:'unknown'});
    app.claude.id = NEW;
    setTime(6000);
    await settled(plugin,6);
    expect(endReports(app,dead)).toHaveLength(1);
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
    // Looked up, never sent again.
    expect(connectsFor(app,OLD)).toHaveLength(2);
  });
});

describe('a connect request of the ended conversation is kept until it can no longer commit', () => {
  it('connect in flight, id switch, next tick retires: the late reply is ended, never armed or remembered for the new id', async () => {
    const setTime = clock(), app = appModel(), store = new Map(), plugin = instance(app,store);
    await connectedThenCleared(app,plugin);
    const gate = deferred();
    app.gate = gate;
    setTime(5000);
    const beating = plugin.beat();
    await vi.waitFor(() => expect(connectsFor(app,OLD)).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve,20));
    app.claude.id = NEW;
    // The tick follows the switch while the old connect is still running.
    await plugin.tick();
    expect(connectsFor(app,NEW)).toHaveLength(0);
    gate.resolve();
    await beating;
    const dead = {...app.binding()};
    expect(dead).toMatchObject({external:OLD});
    await vi.waitFor(() => expect(endReports(app,dead)).toHaveLength(1));
    // The next tick connects the new conversation.
    await plugin.tick();
    await vi.waitFor(() => expect(app.binding()).toMatchObject({external:NEW,state:'connected'}));
    await settled(plugin,2);
    expect(endReports(app,dead)).toHaveLength(1);
    expect(app.claims).not.toContain(dead.generation);
    expect(connectsFor(app,NEW)).toHaveLength(1);
    expect(store.get(`binding:${NEW}`)).toMatchObject({session_id:app.session});
    expect(plugin.appended.map(note => note.message.content[0].text).join('\n')).not.toContain(dead.generation);
  });

  it('retire while the saved bind waits for its route: the wait stops and the binding is ended once', async () => {
    const setTime = clock(), app = appModel(), plugin = instance(app,new Map(),{waitMs:60000,pollMs:0});
    await connectedThenCleared(app,plugin);
    setTime(5000);
    const beating = plugin.beat();
    // Saved, announced from the conversation Claude really runs, so never published.
    await vi.waitFor(() => expect(connectsFor(app,OLD)).toHaveLength(2));
    const dead = {...app.binding()};
    expect(dead).toMatchObject({external:OLD,state:'unknown'});
    app.claude.id = NEW;
    await plugin.tick();
    await beating;
    await settled(plugin,2);
    expect(endReports(app,dead)).toHaveLength(1);
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
  });

  it('a late receipt within the window: lookups find nothing, the app commits later, the next lookup ends it', async () => {
    const setTime = clock(), app = appModel(), plugin = instance(app,new Map());
    await connectedThenCleared(app,plugin);
    app.commitLater = true;
    setTime(5000);
    await plugin.heartbeat();
    expect(app.binding()).toMatchObject({external:OLD,state:'disconnected'});
    setTime(6000);
    app.claude.id = NEW;
    const before = plugin.logs.length;
    await plugin.tick();
    // The request may still commit: automatic reconnect waits, quietly.
    expect(app.lookups).toBeGreaterThan(0);
    expect(connectsFor(app,NEW)).toHaveLength(0);
    setTime(20000);
    app.late();
    const dead = {...app.binding()};
    expect(dead).toMatchObject({external:OLD,state:'unknown'});
    setTime(35000);
    await plugin.heartbeat();
    expect(endReports(app,dead)).toHaveLength(1);
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
    expect(connectsFor(app,OLD)).toHaveLength(2);
    expect(plugin.logs.slice(before)).toEqual(['Ariadne: this conversation is connected to its Ariadne session again.']);
  });

  it('nothing found 60 s after the send ended: the request is dropped and the new conversation connects', async () => {
    const setTime = clock(), app = appModel(), plugin = instance(app,new Map());
    await connectedThenCleared(app,plugin);
    app.commitLater = true;
    setTime(5000);
    await plugin.heartbeat();
    setTime(6000);
    app.claude.id = NEW;
    await plugin.tick();
    setTime(35000);
    await plugin.heartbeat();
    expect(connectsFor(app,NEW)).toHaveLength(0);
    setTime(65000);
    await plugin.heartbeat();
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
    // A commit after the drop is refused by the app while the new conversation is connected.
    app.late();
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
  });

  it('a commit landing right after the drop leaves the manual case: the plain step, then the app\'s Disconnect', async () => {
    const setTime = clock(), app = appModel(), plugin = instance(app,new Map());
    await connectedThenCleared(app,plugin);
    app.commitLater = true;
    setTime(5000);
    await plugin.heartbeat();
    setTime(6000);
    app.claude.id = NEW;
    await plugin.tick();
    setTime(65000);
    app.onLookup = answer => { if (JSON.parse(answer.stdout).data === null && app.late) app.late(); };
    await plugin.heartbeat();
    const dead = app.binding();
    expect(dead).toMatchObject({external:OLD,state:'unknown'});
    expect((await plugin.command('ariadne-connect',app.session)).text).toBe(CONFLICT);
    dead.state = 'disconnected';
    expect((await plugin.command('ariadne-connect',app.session)).text).toContain('connected to Ariadne');
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
  });

  it('a lookup that fails is retried; once it answers, the binding is ended and the new conversation connects', async () => {
    const setTime = clock(), app = appModel(), plugin = instance(app,new Map());
    await connectedThenCleared(app,plugin);
    app.loseNextConnectReply = true;
    setTime(5000);
    await plugin.heartbeat();
    const dead = {...app.binding()};
    app.lookupFails = true;
    setTime(6000);
    app.claude.id = NEW;
    await settled(plugin,2);
    expect(connectsFor(app,NEW)).toHaveLength(0);
    // The explicit connect is not held by the plugin; the app still refuses it.
    expect((await plugin.command('ariadne-connect',app.session)).text).toBe(CONFLICT);
    expect(connectsFor(app,NEW)).toHaveLength(1);
    app.lookupFails = false;
    setTime(40000);
    await plugin.heartbeat();
    expect(endReports(app,dead)).toHaveLength(1);
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
    expect(connectsFor(app,OLD)).toHaveLength(2);
  });

  it('host_unreachable lookups are retried past 60 s: once the app answers, the binding is ended and the new conversation connects', async () => {
    const setTime = clock(), app = appModel(), plugin = instance(app,new Map());
    await connectedThenCleared(app,plugin);
    app.loseNextConnectReply = true;
    setTime(5000);
    await plugin.heartbeat();
    const dead = {...app.binding()};
    app.lookupFails = true;
    setTime(6000);
    app.claude.id = NEW;
    await plugin.tick();
    for (const at of [65000,100000,200000]) { setTime(at); await plugin.heartbeat(); }
    expect(connectsFor(app,NEW)).toHaveLength(0);
    app.lookupFails = false;
    setTime(230000);
    await plugin.heartbeat();
    expect(endReports(app,dead)).toHaveLength(1);
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
  });

  it('a removed session fails the retired lookup with io_error: dropped 60 s after its send, then the new conversation learns the session is gone', async () => {
    const setTime = clock(), app = appModel(), store = new Map(), plugin = instance(app,store);
    await connectedThenCleared(app,plugin);
    app.commitLater = true;
    setTime(5000);
    await plugin.heartbeat();
    app.removed = true;
    setTime(6000);
    app.claude.id = NEW;
    await settled(plugin,2);
    setTime(35000);
    await plugin.heartbeat();
    expect(app.lookups).toBeGreaterThan(0);
    expect(connectsFor(app,NEW)).toHaveLength(0);
    setTime(65000);
    await plugin.heartbeat();
    expect(connectsFor(app,NEW)).toHaveLength(1);
    expect(store.has(`binding:${NEW}`)).toBe(false);
    const lookups = app.lookups;
    await settled(plugin,2);
    expect(app.lookups).toBe(lookups);
    expect(connectsFor(app,NEW)).toHaveLength(1);
  });

  it.each([
    ['timeout',() => failure('timeout')],
    ['a rejected helper call',() => { throw new Error('spawn failed'); }],
  ])('a lookup failing with %s is kept inside 60 s and dropped once a lookup 60 s after the send still fails', async (_, reply) => {
    const setTime = clock(), app = appModel(), plugin = instance(app,new Map());
    await connectedThenCleared(app,plugin);
    app.commitLater = true;
    setTime(5000);
    await plugin.heartbeat();
    app.lookupReply = reply;
    setTime(6000);
    app.claude.id = NEW;
    await plugin.tick();
    setTime(35000);
    await plugin.heartbeat();
    expect(connectsFor(app,NEW)).toHaveLength(0);
    setTime(65000);
    await plugin.heartbeat();
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
  });

  it.each([
    ['a receipt the plugin always rejects',() => success({operation_id:uuid()})],
    ['a permanent refusal',() => failure('invalid_argument')],
  ])('a retired lookup answering %s is dropped at once and the new conversation connects', async (_, reply) => {
    const setTime = clock(), app = appModel(), plugin = instance(app,new Map());
    await connectedThenCleared(app,plugin);
    app.commitLater = true;
    setTime(5000);
    await plugin.heartbeat();
    app.lookupReply = reply;
    setTime(6000);
    app.claude.id = NEW;
    await plugin.tick();
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
    const lookups = app.lookups;
    await settled(plugin,2);
    expect(app.lookups).toBe(lookups);
  });
});

const CONNECT_AGAIN = 'Ariadne has not finished connecting this conversation. Run /ariadne-connect again; if it keeps happening, check this session in Ariadne.';
const remembered = app => new Map([[`binding:${OLD}`,{project_id:app.project,session_id:app.session,saved_at:new Date(0).toISOString()}]]);

describe('a connect that spans a conversation end never sends for the ended conversation', () => {
  it('/clear and the id switch while the reconnect waits for project registration: nothing is sent for the ended id, the new one connects', async () => {
    const app = appModel(), gate = deferred(), plugin = instance(app,remembered(app));
    app.projectGate = gate;
    await plugin.start();
    await vi.waitFor(() => expect(gate.reached).toBe(true));
    app.claude.real = NEW;
    await plugin.end('clear');
    app.claude.id = NEW;
    await plugin.tick();
    gate.resolve();
    await new Promise(resolve => setTimeout(resolve,20));
    await settled(plugin,2);
    expect(connectsFor(app,OLD)).toHaveLength(0);
    expect(connectsFor(app,NEW)).toHaveLength(1);
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
  });

  it('an explicit /ariadne-connect spanning /clear and the id switch answers "not finished", sends nothing for the ended id, and the next connect works', async () => {
    const app = appModel(), gate = deferred(), plugin = instance(app,new Map());
    await plugin.start();
    app.projectGate = gate;
    const answering = plugin.command('ariadne-connect',app.session);
    await vi.waitFor(() => expect(gate.reached).toBe(true));
    app.claude.real = NEW;
    await plugin.end('clear');
    app.claude.id = NEW;
    await plugin.tick();
    gate.resolve();
    expect((await answering).text).toBe(CONNECT_AGAIN);
    expect(connectsFor(app,OLD)).toHaveLength(0);
    expect((await plugin.command('ariadne-connect',app.session)).text).toContain('connected to Ariadne');
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
  });

  it.each([
    // The kept request found nothing yet; the app commits it later.
    ['its lookup',app => { app.commitLater = true; },'lookupGate',app => app.late()],
    // The kept request saved; its route is not published.
    ['its status check',app => { app.loseNextConnectReply = true; },'statusGate',() => {}],
  ])('retire during verification (%s) of a kept request: nothing new is sent, the kept one is ended once it is found, the new conversation connects', async (_, keep, gateName, commit) => {
    const setTime = clock(), app = appModel(), plugin = instance(app,new Map());
    await connectedThenCleared(app,plugin);
    keep(app);
    setTime(5000);
    await plugin.heartbeat();
    expect(connectsFor(app,OLD)).toHaveLength(2);
    const gate = deferred();
    app[gateName] = gate;
    setTime(10000);
    const beating = plugin.beat();
    await vi.waitFor(() => expect(gate.reached).toBe(true));
    app.claude.id = NEW;
    await plugin.tick();
    gate.resolve();
    await beating;
    expect(connectsFor(app,OLD)).toHaveLength(2);
    setTime(20000);
    commit(app);
    const dead = {...app.binding()};
    expect(dead).toMatchObject({external:OLD,state:'unknown'});
    setTime(35000);
    await plugin.heartbeat();
    await settled(plugin,2);
    expect(endReports(app,dead)).toHaveLength(1);
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
    expect(connectsFor(app,OLD)).toHaveLength(2);
    expect(connectsFor(app,NEW)).toHaveLength(1);
  });

  it('a second /clear while the reconnect drains the first end report: the reconnect sends nothing for the id that just ended', async () => {
    const THIRD = 'conversation-after-second-clear';
    const app = appModel(), plugin = instance(app,new Map());
    await plugin.start();
    await plugin.command('ariadne-connect',app.session);
    // Claude switches the id first; the end report fails once, so it stays retired.
    app.claude.real = NEW;
    app.claude.id = NEW;
    app.reportFails = true;
    await plugin.end('clear');
    await plugin.tick();
    expect(connectsFor(app,NEW)).toHaveLength(0);
    app.reportFails = false;
    const gate = deferred();
    app.reportGate = gate;
    const beating = plugin.beat();
    await vi.waitFor(() => expect(gate.reached).toBe(true));
    app.claude.real = THIRD;
    await plugin.end('clear');
    gate.resolve();
    await beating;
    await plugin.tick();
    expect(connectsFor(app,NEW)).toHaveLength(0);
    app.claude.id = THIRD;
    await settled(plugin,2);
    expect(connectsFor(app,NEW)).toHaveLength(0);
    expect(connectsFor(app,THIRD)).toHaveLength(1);
    expect(app.binding()).toMatchObject({external:THIRD,state:'connected'});
  });

  it('an explicit /ariadne-connect whose remember waits across /clear and the id switch: no note in the new conversation, "not finished", the binding is ended, the new one connects', async () => {
    const app = appModel(), store = new Map(), plugin = instance(app,store), gate = deferred();
    await plugin.start();
    store.setGate = gate;
    const answering = plugin.command('ariadne-connect',app.session);
    await vi.waitFor(() => expect(gate.reached).toBe(true));
    const ended = {...app.binding()};
    app.claude.real = NEW;
    await plugin.end('clear');
    app.claude.id = NEW;
    await plugin.tick();
    gate.resolve();
    expect((await answering).text).toBe(CONNECT_AGAIN);
    expect(plugin.appended).toHaveLength(0);
    expect(endReports(app,ended)).toHaveLength(1);
    expect(store.has(`binding:${OLD}`)).toBe(false);
    await settled(plugin,2);
    expect(endReports(app,ended)).toHaveLength(1);
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
    expect(plugin.appended.some(row => JSON.stringify(row).includes(ended.generation))).toBe(false);
    expect(store.has(`binding:${OLD}`)).toBe(false);
  });

  it('a reconnect whose remember waits across /clear and the id switch: no note, the ended id is not remembered again, the new one connects', async () => {
    const app = appModel(), store = remembered(app), plugin = instance(app,store), gate = deferred();
    store.setGate = gate;
    await plugin.start();
    await vi.waitFor(() => expect(gate.reached).toBe(true));
    const ended = {...app.binding()};
    expect(ended).toMatchObject({external:OLD});
    app.claude.real = NEW;
    await plugin.end('clear');
    app.claude.id = NEW;
    await plugin.tick();
    gate.resolve();
    await new Promise(resolve => setTimeout(resolve,20));
    expect(plugin.appended).toHaveLength(0);
    expect(endReports(app,ended)).toHaveLength(1);
    expect(store.has(`binding:${OLD}`)).toBe(false);
    await settled(plugin,2);
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
    expect(plugin.appended.some(row => JSON.stringify(row).includes(ended.generation))).toBe(false);
    expect(store.has(`binding:${OLD}`)).toBe(false);
  });
});

// Every await on a connect path: by the name the plugin gives it (a step, run
// through the test's step hook) or by the helper or store call the model holds
// (a gate, inside setup's connect attempt and remember's write). 'note' is the
// routing note's own await: the connect has answered by then and never waits for it.
const PATHS = Object.freeze({
  // A second /ariadne-connect of a connected conversation (it replaces a loop).
  explicit:{steps:['connect','replaced','remember','bind','note'],gates:['gate','statusGate','setGate']},
  // `claude --resume` of a remembered conversation.
  automatic:{steps:['drain','connect','remember','bind','note'],gates:['projectGate','gate','statusGate','setGate']},
});
const SUCCESS = 'This conversation is connected to Ariadne.';
const RECONNECTED = 'Ariadne: this conversation is connected to its Ariadne session again.';
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
// How a conversation end lands at a point.
const SPANS = Object.freeze({
  // /clear ran to its end, Claude switched the id, and a tick followed it.
  'end, switch, tick':async ctx => {
    await ctx.plugin.end('clear');
    ctx.app.claude.id = NEW;
    await ctx.plugin.tick();
  },
  // /clear has started (its end report is in flight, health not reset yet); the id switches after.
  'end started':ctx => { ctx.ending = ctx.plugin.end('clear'); },
});
async function connectPath(kind) {
  const app = appModel(), store = kind === 'automatic' ? remembered(app) : new Map();
  const ctx = {app,store,step:async () => {},ending:null,mark:null};
  ctx.plugin = instance(app,store,undefined,name => ctx.step(name));
  if (kind === 'explicit') {
    await ctx.plugin.start();
    expect((await ctx.plugin.command('ariadne-connect',app.session)).text).toContain(SUCCESS);
  }
  ctx.hold = name => { const gate = deferred(); if (name === 'setGate') store.setGate = gate; else app[name] = gate; return gate; };
  // The explicit answer; the automatic reconnect answers nothing and is done once `done` holds.
  ctx.run = async done => {
    if (kind === 'explicit') return (await ctx.plugin.command('ariadne-connect',app.session)).text;
    await ctx.plugin.start();
    await vi.waitFor(() => expect(done()).toBe(true));
    await sleep(50);
    return null;
  };
  ctx.span = async variant => {
    ctx.mark = {appended:ctx.plugin.appended.length,logs:ctx.plugin.logs.length};
    ctx.dead = app.binding() ? {...app.binding()} : null;
    app.claude.real = NEW;
    await SPANS[variant](ctx);
  };
  return ctx;
}
const noEndTwice = app => {
  const ends = app.reports.filter(event => event.kind === 'disconnected').map(event => `${event.binding_id}:${event.generation}`);
  expect(new Set(ends).size).toBe(ends.length);
};
const points = Object.entries(PATHS).flatMap(([kind,{steps,gates}]) => [
  ...steps.map(name => ({kind,step:name})),...gates.map(name => ({kind,gate:name})),
]).flatMap(point => Object.keys(SPANS).map(variant => [point.kind,point.step ? `step ${point.step}` : `gate ${point.gate}`,variant,point]));

describe('a conversation end at any await of a connect stops it the same way', () => {
  it.each(Object.keys(PATHS))('the %s path names every await it takes', async kind => {
    const ctx = await connectPath(kind), names = [];
    ctx.step = async name => { names.push(name); };
    const answer = await ctx.run(() => ctx.plugin.logs.includes(RECONNECTED));
    if (kind === 'explicit') expect(answer).toContain(SUCCESS);
    expect(names).toEqual(PATHS[kind].steps);
  });

  it.each(points)('%s path, %s, %s: no note or success for the ended conversation, the old binding ends once, its memory goes, the next tick binds the new conversation', async (kind, _, variant, point) => {
    const ctx = await connectPath(kind), {app,store,plugin} = ctx;
    let spanned = false;
    const span = async () => { await ctx.span(variant); spanned = true; };
    let fired = false;
    ctx.step = async name => { if (name === point.step && !fired) { fired = true; await span(); } };
    const gate = point.gate ? ctx.hold(point.gate) : null;
    const running = ctx.run(() => spanned);
    if (gate) {
      await vi.waitFor(() => expect(gate.reached).toBe(true));
      await span();
      gate.resolve();
    }
    const answer = await running;
    await vi.waitFor(() => expect(spanned).toBe(true));
    if (ctx.ending) { await ctx.ending; app.claude.id = NEW; }
    // The note is never awaited: the connect answered (or logged) success as it
    // connected, before the note went out, so this end is an ordinary /clear
    // and the span's own tick may already reconnect the new conversation.
    const note = point.step === 'note';
    if (kind === 'explicit') expect(answer).toEqual(note ? expect.stringContaining(SUCCESS) : CONNECT_AGAIN);
    const reconnects = connectsFor(app,NEW).length;
    expect(plugin.logs.slice(ctx.mark.logs).filter(text => text === RECONNECTED)).toHaveLength(reconnects);
    expect(plugin.appended.slice(ctx.mark.appended)).toHaveLength(reconnects);
    const dead = note ? ctx.dead : app.binding() ? {...app.binding()} : null;
    if (kind === 'explicit' || note) expect(dead).not.toBeNull();
    if (dead) {
      expect(dead).toMatchObject({external:OLD});
      expect(endReports(app,dead)).toHaveLength(1);
    }
    noEndTwice(app);
    await plugin.tick();
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
    expect(store.has(`binding:${OLD}`)).toBe(false);
    await settled(plugin,2);
    if (dead) expect(endReports(app,dead)).toHaveLength(1);
    noEndTwice(app);
    expect(store.has(`binding:${OLD}`)).toBe(false);
    if (dead) expect(plugin.appended.slice(ctx.mark.appended).map(row => row.message.content[0].text).join('\n')).not.toContain(dead.id);
    expect(connectsFor(app,NEW)).toHaveLength(1);
  });

  it.each(Object.keys(PATHS))('a %s connect held at every await of the same conversation still connects', async kind => {
    const ctx = await connectPath(kind), {app,store,plugin} = ctx;
    const names = [];
    ctx.step = async name => { names.push(name); await sleep(0); };
    const gates = PATHS[kind].gates.map(ctx.hold), before = plugin.appended.length;
    const running = ctx.run(() => plugin.logs.includes(RECONNECTED));
    await vi.waitFor(() => {
      for (const gate of gates) if (gate.reached) gate.resolve();
      expect(gates.every(gate => gate.reached)).toBe(true);
    });
    const answer = await running;
    if (kind === 'explicit') expect(answer).toContain(SUCCESS);
    else expect(plugin.logs).toContain(RECONNECTED);
    expect(names).toEqual(PATHS[kind].steps);
    const bound = app.binding();
    expect(bound).toMatchObject({external:OLD,state:'connected'});
    expect(endReports(app,bound)).toHaveLength(0);
    // The note goes out after the answer.
    await vi.waitFor(() => expect(plugin.appended.slice(before).map(row => row.message.content[0].text).join('\n')).toContain(bound.generation));
    expect(store.get(`binding:${OLD}`)).toMatchObject({session_id:app.session});
  });
});

describe('connects and drains that overlap', () => {
  it('a heartbeat drain waiting on a retired lookup while an explicit connect drains, connects, and /clear queues an end report that fails once: the report is kept and sent, the next conversation connects', async () => {
    const THIRD = 'conversation-after-second-clear';
    const setTime = clock(), app = appModel(), plugin = instance(app,new Map());
    await connectedThenCleared(app,plugin);
    // A stale heartbeat bind whose reply is lost and that saved nothing: its
    // request is kept and, after the id switch, retired for a lookup.
    app.commitLater = true;
    setTime(5000);
    await plugin.heartbeat();
    expect(connectsFor(app,OLD)).toHaveLength(2);
    app.claude.id = NEW;
    await plugin.tick();
    expect((await plugin.command('ariadne-connect',app.session)).text).toContain(SUCCESS);
    // Past the late-commit window: the heartbeat's drain waits on that lookup.
    setTime(70000);
    const lookup = deferred();
    app.lookupGate = lookup;
    const beating = plugin.beat();
    await vi.waitFor(() => expect(lookup.reached).toBe(true));
    let answered = false;
    const answering = plugin.command('ariadne-connect',app.session).then(result => { answered = true; return result; });
    await sleep(50);
    // A connect that waits for the running drain needs the lookup to answer first.
    if (!answered) lookup.resolve();
    expect((await answering).text).toContain(SUCCESS);
    const live = {...app.binding()};
    expect(live).toMatchObject({external:NEW,state:'connected'});
    app.claude.real = THIRD;
    app.reportFails = true;
    await plugin.end('clear');
    expect(endReports(app,live)).toHaveLength(0);
    lookup.resolve();
    await beating;
    app.reportFails = false;
    app.claude.id = THIRD;
    setTime(80000);
    await settled(plugin,3);
    expect(endReports(app,live)).toHaveLength(1);
    expect(app.binding()).toMatchObject({external:THIRD,state:'connected'});
    expect(connectsFor(app,THIRD)).toHaveLength(1);
  });

  it('/clear finished and Claude switched the id, then an explicit connect before the tick, and the tick during its publication wait: the new id connects, nothing is retired, no "not finished"', async () => {
    const app = appModel(), store = new Map(), plugin = instance(app,store);
    await plugin.start();
    expect((await plugin.command('ariadne-connect',app.session)).text).toContain(SUCCESS);
    app.claude.real = NEW;
    await plugin.end('clear');
    app.claude.id = NEW;
    const status = deferred();
    app.statusGate = status;
    const answering = plugin.command('ariadne-connect',app.session);
    await vi.waitFor(() => expect(status.reached).toBe(true));
    await plugin.tick();
    status.resolve();
    expect((await answering).text).toContain(SUCCESS);
    const live = {...app.binding()};
    expect(live).toMatchObject({external:NEW,state:'connected'});
    expect(connectsFor(app,NEW)).toHaveLength(1);
    expect(store.get(`binding:${NEW}`)).toMatchObject({session_id:app.session});
    await settled(plugin,2);
    expect(endReports(app,live)).toHaveLength(0);
    expect(app.binding()).toMatchObject({external:NEW,state:'connected',generation:live.generation});
    expect(connectsFor(app,NEW)).toHaveLength(1);
    expect(plugin.appended.map(row => row.message.content[0].text).join('\n')).toContain(live.generation);
  });

  it('/clear still sending its end report when Claude switches the id and the tick reconnects: the new id connects on that tick, not fenced', async () => {
    const app = appModel(), plugin = instance(app,new Map());
    await plugin.start();
    expect((await plugin.command('ariadne-connect',app.session)).text).toContain(SUCCESS);
    const old = {...app.binding()};
    app.claude.real = NEW;
    const report = deferred();
    app.reportGate = report;
    const ending = plugin.end('clear');
    await vi.waitFor(() => expect(report.reached).toBe(true));
    app.claude.id = NEW;
    const ticking = plugin.tick();
    await sleep(50);
    report.resolve();
    await ending;
    await ticking;
    await vi.waitFor(() => expect(app.binding()).toMatchObject({external:NEW,state:'connected'}));
    expect(endReports(app,old)).toHaveLength(1);
    expect(connectsFor(app,NEW)).toHaveLength(1);
    expect(plugin.logs).toContain(RECONNECTED);
  });

  it('a second /clear while the plugin still follows the first one\'s new id: that id is held, never bound; the id after it connects', async () => {
    const THIRD = 'conversation-after-second-clear';
    const app = appModel(), plugin = instance(app,new Map());
    await connectedThenCleared(app,plugin);
    app.claude.id = NEW;
    const announced = deferred();
    app.announceGate = announced;
    const ticking = plugin.tick();
    await vi.waitFor(() => expect(announced.reached).toBe(true));
    app.claude.real = THIRD;
    const ending = plugin.end('clear');
    await sleep(20);
    announced.resolve();
    await ending;
    await ticking;
    await settled(plugin,1);
    expect(connectsFor(app,NEW)).toHaveLength(0);
    app.claude.id = THIRD;
    await settled(plugin,2);
    expect(connectsFor(app,NEW)).toHaveLength(0);
    expect(connectsFor(app,THIRD)).toHaveLength(1);
    expect(app.binding()).toMatchObject({external:THIRD,state:'connected'});
  });

  it('/clear waiting in stop() for a claim in flight while a heartbeat drains, then the end report fails once: the loop stays retired, its report is sent, the new id connects', async () => {
    const app = appModel(), plugin = instance(app,new Map());
    await plugin.start();
    expect((await plugin.command('ariadne-connect',app.session)).text).toContain(SUCCESS);
    const old = {...app.binding()};
    // A tick's claim is in flight.
    const claim = deferred();
    app.claimGate = claim;
    const ticking = plugin.tick();
    await vi.waitFor(() => expect(claim.reached).toBe(true));
    // /clear retires the loop; its stop() waits for that claim.
    app.claude.real = NEW;
    app.reportFails = true;
    const ending = plugin.end('clear');
    await sleep(20);
    // The heartbeat drain runs while the retired loop has no report queued yet.
    const beating = plugin.beat();
    await sleep(50);
    claim.resolve();
    await ending;
    await beating;
    await ticking;
    expect(endReports(app,old)).toHaveLength(0);
    // The app recovers and Claude switches the id.
    app.reportFails = false;
    app.claude.id = NEW;
    await settled(plugin,2);
    expect(endReports(app,old)).toHaveLength(1);
    expect(app.binding()).toMatchObject({external:NEW,state:'connected'});
    expect(connectsFor(app,NEW)).toHaveLength(1);
    expect(plugin.logs).toContain(RECONNECTED);
  });
});

describe('other conversation changes stay as they were', () => {
  it.each([['before','the end event'],['after','the end event']])('/resume, Claude switching the id %s %s, connects the resumed conversation once', async order => {
    const RESUMED = 'conversation-resumed';
    const app = appModel(), plugin = instance(app,new Map());
    await plugin.start();
    await plugin.command('ariadne-connect',app.session);
    app.claude.real = RESUMED;
    if (order === 'before') app.claude.id = RESUMED;
    await plugin.end('resume',OLD);
    await plugin.tick();
    app.claude.id = RESUMED;
    await settled(plugin,2);
    expect(connectsFor(app,OLD)).toHaveLength(1);
    expect(connectsFor(app,RESUMED)).toHaveLength(1);
    expect(app.binding()).toMatchObject({external:RESUMED,state:'connected'});
  });

  it('a conversation with no session.end (/compact keeps it) keeps its loop and never reconnects', async () => {
    const app = appModel(), plugin = instance(app,new Map());
    await plugin.start();
    await plugin.command('ariadne-connect',app.session);
    await settled(plugin,2);
    expect(connectsFor(app,OLD)).toHaveLength(1);
    expect(app.claims.length).toBeGreaterThan(0);
    expect(app.binding()).toMatchObject({external:OLD,state:'connected'});
  });
});

describe('same-ID /clear builds stay supported', () => {
  it('reconnects the kept conversation id at its first turn (pinned in register.test.js too)', async () => {
    const app = appModel(), plugin = instance(app,new Map());
    await plugin.start();
    await plugin.command('ariadne-connect',app.session);
    await plugin.end('clear');
    await plugin.tick();
    expect(connectsFor(app,OLD)).toHaveLength(1);
    await plugin.turn();
    await vi.waitFor(async () => { await plugin.tick(); expect(app.binding()).toMatchObject({external:OLD,state:'connected'}); });
    expect(connectsFor(app,OLD)).toHaveLength(2);
  });

  it('reconnects the kept conversation id at the first heartbeat 5 s after the end, with no turn', async () => {
    const setTime = clock(), app = appModel(), plugin = instance(app,new Map());
    await plugin.start();
    await plugin.command('ariadne-connect',app.session);
    await plugin.end('clear');
    setTime(5000);
    await plugin.heartbeat();
    expect(app.binding()).toMatchObject({external:OLD,state:'connected'});
    expect(connectsFor(app,OLD)).toHaveLength(2);
  });
});
