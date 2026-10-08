import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, chmod, appendFile, rename } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

export const thread = 'ariadne-scripted-existing-thread';
export async function cliRequest(cli, args, request, env = process.env) {
  const child = spawn(cli, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { errors += bytes; });
  child.stdin.end(request === undefined ? undefined : JSON.stringify(request));
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
    assert.equal(errors, '', `Scripted journey CLI diagnostic: ${errors}`);
    return { code, output, value: JSON.parse(output) };
  } finally { clearTimeout(timer); }
}
export async function snapshot(configuration) {
  return JSON.parse(await readFile(configuration.sessionPath, 'utf8'));
}
// The connect receipt returns before the supervisor worker commits its Connected
// report; an apply that races it is rejected as binding_mismatch. Wait for the route.
export async function awaitConnected(configuration, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let binding;
  do {
    binding = (await snapshot(configuration)).bindings?.[configuration.bindingId];
    if (binding?.connection_state === 'connected' && binding?.dispatch_state === 'enabled') return binding;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`Binding ${configuration.bindingId} never became the connected route: ${JSON.stringify(binding)}`);
}
async function optional(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
const applyRequest = operations => ({ op_id: randomUUID(), source_input_id: null, attempt_id: null,
  expected_item_revisions: {}, expected_topic_revisions: {}, summary: '', operations, input_result: null });

export async function admissions(configuration) {
  try { return (await readFile(configuration.queuedPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function atomicJson(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value)); await rename(`${path}.tmp`, path);
}
export async function recordAdmission(configuration, args) {
  assert.deepEqual(args.slice(0, 6), ['queue', '--remote', `unix://${configuration.socket}`, '--thread', configuration.thread ?? thread, '--message']);
  assert.equal(args.length, 7);
  const marker = args[6].match(/^\[ARIADNE_INPUT:([0-9a-f-]{36}):([0-9a-f-]{36})\]\n/);
  assert.ok(marker, 'Queue admission requires the saved input/attempt marker');
  const body = JSON.parse(args[6].slice(marker[0].length));
  assert.equal(body.source_input_id, marker[1]);
  assert.match(body.binding_id, /^[0-9a-f-]{36}$/); assert.match(body.generation, /^[0-9a-f-]{36}$/);
  const previous = await admissions(configuration);
  assert.ok(!previous.some(entry => entry.attemptId === marker[2]), 'No blind resend of an admitted host turn');
  const entry = { ordinal: previous.length + 1, inputId: marker[1], attemptId: marker[2], bindingId: body.binding_id,
    generation: body.generation, turnId: `scripted-native-${marker[2]}`, admittedAt: Date.now(), payload: args[6], args: args.slice(0, 6) };
  await appendFile(configuration.queuedPath, `${JSON.stringify(entry)}\n`);
  return entry;
}
export async function completeTurn(configuration, admission) {
  const saved = (await admissions(configuration)).find(entry => entry.attemptId === admission.attemptId);
  assert.deepEqual(admission, saved, 'Completion must identify an exact existing B/G/input/attempt/turn admission');
  const completed = await optional(configuration.completePath) ?? [];
  assert.ok(!completed.some(entry => entry.attemptId === admission.attemptId), 'Host completion is explicit and occurs once');
  await atomicJson(configuration.completePath, [...completed, admission]);
}
/** The slim envelope carries the owner's exact text and target IDs, never the saved payload or item body. */
export function assertSlimEnvelope(admission, input) {
  const envelope = JSON.parse(admission.payload.slice(admission.payload.indexOf('\n') + 1));
  assert.equal(envelope.source_input_id, input.id); assert.equal(envelope.text, input.payload.text);
  assert.equal(envelope.selected_option_id ?? null, input.payload.selected_option_id);
  assert.equal(envelope.item_id ?? null, input.target.item_id);
  for (const absent of ['saved_input', 'current_item', 'recent_context', 'instruction']) assert.equal(Object.hasOwn(envelope, absent), false, absent);
  return envelope;
}
export function journeyResultRequest(configuration, admission, session, reply) {
  const input = session.inputs[admission.inputId];
  assert.equal(input.binding_id, configuration.bindingId);
  assert.equal(admission.bindingId, configuration.bindingId); assert.equal(admission.generation, configuration.generation);
  const attempt = input.attempts.find(attempt => attempt.id === admission.attemptId);
  assert.ok(attempt); assert.equal(attempt.formatted_payload, admission.payload);
  const owner = session.messages.find(message => message.id === input.message_id);
  return { ...applyRequest([{ op: 'reply', ref: 'native_reply', item: { id: configuration.itemId }, text: reply, round_id: null }]),
    source_input_id: input.id, attempt_id: attempt.id,
    expected_item_revisions: { [configuration.itemId]: session.items[configuration.itemId].revision },
    input_result: { outcome: 'answered', explanation: `Explicit scripted result ${admission.ordinal}`, reply_refs: [{ ref: 'native_reply' }], followup_item_refs: [], handled_through_message_number: owner.number } };
}
export async function publishResult(configuration, admission, reply, env = process.env) {
  const request = journeyResultRequest(configuration, admission, await snapshot(configuration), reply);
  const applied = await cliRequest(configuration.cli, ['apply', '--binding', configuration.bindingId, '--generation', configuration.generation, '--json-stdin'], request, env);
  assert.equal(applied.code, 0); assert.equal(applied.value.session_id, configuration.sessionId);
  return { request, receipt: applied.value };
}

export function journeySeedRequest(bindingId) {
  const question = 'Which native delivery window should we use?', ask = 'Choose the saved option and explain it in your own words.';
  const options = [{ id: 'native-window', label: 'Use the native window', consequence: 'Preserve this exact saved choice', recommended: true }];
  const request = applyRequest([
    { op: 'topic.add', ref: 'native_topic', name: 'Native provider journey' },
    { op: 'item.add', ref: 'native_item', topic: { ref: 'native_topic' }, parent: null, question, type: 'task', status: 'open', owner: { kind: 'me' }, ask: null, options: null, note: null, links: null, outcome: null, why: null, replaced_by: null, source_round_id: null },
    { op: 'item.ask', item: { ref: 'native_item' }, ask, options, recipient_binding_id: bindingId },
  ]);
  return { question, ask, options, request };
}

// This replaces only the pinned existing provider endpoint/executable. Every
// domain read, connection, owner mutation and explicit reply/result is real CLI/Core/Store.
export async function startScriptedProvider(root, cli, evidence) {
  const provider = join(root, 'provider'), project = join(root, 'project');
  const discoveryProject = join(root, 'discovery-project'), discoveryThread = 'ariadne-scripted-discovery-thread';
  const treeProject = join(root, 'tree-project'), treeThread = 'ariadne-scripted-tree-thread';
  const historyProject = join(root, 'history-project'), historyThread = 'ariadne-scripted-history-thread';
  await mkdir(provider, { recursive: true }); await mkdir(project); await mkdir(discoveryProject); await mkdir(treeProject); await mkdir(historyProject);
  const socket = join(provider, 'daemon.sock'), executable = join(provider, 'codex');
  const queuedPath = join(provider, 'admissions.jsonl'), completePath = join(provider, 'complete.json');
  const bindingPath = join(provider, 'binding.json'), calls = [];
  const configuration = { cli, project, provider, socket, executable, queuedPath, completePath, bindingPath, thread,
    discovery: { projectRoot: discoveryProject, externalSessionId: discoveryThread, socketPath: socket },
    tree: { projectRoot: treeProject, externalSessionId: treeThread, socketPath: socket },
    history: { projectRoot: historyProject, externalSessionId: historyThread, socketPath: socket, socket, thread: historyThread,
      queuedPath: join(provider, 'history-admissions.jsonl'), completePath: join(provider, 'history-complete.json') },
    appArgs: ['--codex-executable', executable, '--codex-home', provider, '--codex-endpoint', socket] };
  const executableSource = `#!${process.execPath}\nimport{appendFileSync}from'node:fs';\nimport{recordAdmission}from ${JSON.stringify(import.meta.url)};\nconst args=process.argv.slice(2);\nif(args.length===1&&args[0]==='--version'){appendFileSync(${JSON.stringify(join(provider, 'versions.jsonl'))},'version\\n');console.log('codex-cli 0.160.0');}\nelse{try{const configuration=${JSON.stringify(configuration)};await recordAdmission(args[4]===configuration.history.externalSessionId?configuration.history:configuration,args);}catch{process.exitCode=3;}}\n`;
  // The fixture executable is a module even without a .mjs extension.
  await writeFile(join(provider, 'package.json'), '{"type":"module"}');
  await writeFile(executable, executableSource); await chmod(executable, 0o700);
  const fixtures = new URL('../../../../contracts/providers/codex/0.160.0/fixtures/', import.meta.url);
  const load = async name => JSON.parse(await readFile(new URL(name, fixtures), 'utf8'));
  let failure;
  async function turns(control) {
    const queued = await admissions(control), completed = await optional(control.completePath) ?? [];
    for (const control of completed) assert.deepEqual(queued.find(entry => entry.attemptId === control.attemptId), control, 'Foreign completion identity cannot affect another turn');
    const result = await load('turns-response.json');
    // Existing Codex history reads are descending: the newest turn precedes
    // the prior queue anchor while the admission journal retains FIFO order.
    return { ...result, data: [...queued].reverse().map(entry => {
      const turn = globalThis.structuredClone(result.data[0]), complete = completed.some(control => control.attemptId === entry.attemptId);
      turn.id = entry.turnId; turn.status = complete ? 'completed' : 'inProgress';
      turn.startedAt = Math.floor(entry.admittedAt / 1000); turn.completedAt = complete ? turn.startedAt + 1 : null;
      turn.durationMs = complete ? 1000 : null;
      turn.items = [{ type: 'userMessage', id: `${entry.turnId}-owner`, clientId: `${entry.turnId}-client`, content: [{ type: 'text', text: entry.payload, text_elements: [] }] }];
      return turn;
    }) };
  }
  const server = http.createServer();
  const websocket = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, stream, head) => websocket.handleUpgrade(request, stream, head, client => websocket.emit('connection', client)));
  websocket.on('connection', client => client.on('message', async bytes => {
    try {
      const request = JSON.parse(bytes.toString()), call = { method: request.method, params: request.params }; calls.push(call);
      let result;
      switch (request.method) {
        case 'initialized': return;
        case 'initialize': result = await load('initialize-response.json'); result.codexHome = provider; break;
        case 'thread/read': {
          const requested = request.params.threadId;
          assert.ok([thread, discoveryThread, treeThread, historyThread, 'another-explicit-thread'].includes(requested), 'Only explicit candidates and the deliberate identity-mismatch probe are readable');
          // A reachable host reports its actual existing session for the known
          // negative probe. Real qualification must reject that different ID;
          // closing the transport would test HostUnreachable instead.
          const actual = requested === 'another-explicit-thread' ? thread : requested;
          result = await load('read-response.json'); result.thread.id = actual; result.thread.sessionId = actual;
          result.thread.cwd = actual === thread ? project : actual === discoveryThread ? discoveryProject : actual === treeThread ? treeProject : historyProject; break;
        }
        case 'thread/loaded/list': result = { data: [thread, discoveryThread, treeThread, historyThread], nextCursor: null }; break;
        case 'thread/queue/list': result = { data: [], nextCursor: null }; break;
        case 'thread/turns/list':
          assert.ok([thread, discoveryThread, treeThread, historyThread].includes(request.params.threadId));
          result = request.params.threadId === thread ? await turns(configuration) : request.params.threadId === historyThread ? await turns(configuration.history) : { data: [], nextCursor: null }; break;
        default: throw new Error(`Unexpected provider operation ${request.method}`);
      }
      if (request.method === 'thread/turns/list') call.turns = result.data.map(turn => ({ id: turn.id, status: turn.status,
        originals: turn.items.filter(item => item.type === 'userMessage').map(item => ({ id: item.id,
          marker: item.content[0].text.split('\n')[0], sha256: createHash('sha256').update(item.content[0].text).digest('hex') })) }));
      client.send(JSON.stringify({ id: request.id, result }));
    } catch (error) { failure ||= error; client.close(); }
  }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await chmod(socket, 0o600);
  await writeFile(join(root, 'journey.json'), JSON.stringify(configuration));
  return { configuration, async stop() {
    for (const client of websocket.clients) client.terminate();
    await new Promise(resolve => websocket.close(resolve)); await new Promise(resolve => server.close(resolve));
    await writeFile(join(evidence, 'provider-calls.json'), JSON.stringify(calls, null, 2));
    if (failure) throw failure;
  } };
}

export async function seedJourney(configuration, env = process.env) {
  const registered = await cliRequest(configuration.cli, ['project', 'register', '--json-stdin'], {
    session: null, command: { command: 'project_register', api_version: 1, op_id: randomUUID(), params: { canonical_root: configuration.project } },
  }, env);
  assert.equal(registered.code, 0);
  const projectId = registered.value.data.project_id;
  const request = { session: null, command: { command: 'binding_connect', api_version: 1, op_id: randomUUID(), params: {
    project_id: projectId, adapter_id: 'codex', external_session_id: thread, endpoint: { kind: 'unix_socket', path: configuration.socket },
    configuration: { namespace: 'codex', values: {} }, existing_session_id: null,
  } } };
  const connected = await cliRequest(configuration.cli, ['binding', 'connect', '--json-stdin'], request, env);
  assert.equal(connected.code, 0); assert.equal(connected.value.ok, true);
  const receipt = connected.value.data;
  assert.equal(receipt.data.kind, 'binding_connect');
  const bindingId = receipt.data.binding_id, generation = receipt.data.generation, sessionId = receipt.session_id;
  // ADR-0082: the store lives under the data root, never inside the project.
  const home = env.ARIADNE_HOME ?? process.env.ARIADNE_HOME;
  const sessionPath = join(home, 'projects', projectId, 'sessions', `${sessionId}.json`);
  const versionsPath = join(configuration.provider, 'versions.jsonl');
  const beforeVersions = await readFile(versionsPath);
  const replay = await cliRequest(configuration.cli, ['binding', 'connect', '--json-stdin'], request, env);
  assert.equal(replay.code, 0); assert.equal(replay.output, connected.output);
  assert.deepEqual(await readFile(versionsPath), beforeVersions, 'Exact replay performs no provider qualification');
  const before = await readFile(sessionPath);
  const conflict = globalThis.structuredClone(request); conflict.command.params.existing_session_id = sessionId;
  const rejected = await cliRequest(configuration.cli, ['binding', 'connect', '--json-stdin'], conflict, env);
  assert.equal(rejected.code, 3); assert.equal(rejected.value.error.code, 'operation_reused');
  assert.deepEqual(await readFile(sessionPath), before);
  const wrongIdentity = globalThis.structuredClone(request);
  wrongIdentity.command.op_id = randomUUID(); wrongIdentity.command.params.external_session_id = 'another-explicit-thread';
  const wrong = await cliRequest(configuration.cli, ['binding', 'connect', '--json-stdin'], wrongIdentity, env);
  assert.notEqual(wrong.code, 0); assert.equal(wrong.value.error.code, 'binding_mismatch');
  assert.deepEqual(await readFile(sessionPath), before, 'Wrong selected identity cannot alter the canonical session');
  // The instruction names the exact CLI invocation (ADR-0077: the installed
  // helper path, optionally prefixed with ARIADNE_HOME=); the arguments after
  // `read` are what must be pasteable.
  const read = receipt.data.setup_instruction.split('\n').find(line => line.startsWith('Use ') && line.includes(' read --binding '));
  assert.ok(read, 'Saved setup contains pasteable canonical read arguments');
  const readArgs = read.slice(read.indexOf(' read --binding ') + 1).replace(/\.$/, '').split(/\s+/);
  assert.equal((await cliRequest(configuration.cli, readArgs, undefined, env)).code, 0);
  const { question, ask, options, request: seed } = journeySeedRequest(bindingId);
  const apply = receipt.data.setup_instruction.split('\n').find(line => line.startsWith('Publish full item replies with ') && line.includes(' apply --binding '));
  assert.ok(apply, 'Saved setup contains pasteable canonical apply arguments');
  const applyArgs = apply.slice(apply.indexOf(' apply --binding ') + 1).split('. Use explicit')[0].split(/\s+/);
  const seeded = await cliRequest(configuration.cli, applyArgs, seed, env);
  assert.equal(seeded.code, 0);
  const demoProject = join(configuration.project, '..', 'canonical-demo'); await mkdir(demoProject);
  const demo = await cliRequest(configuration.cli, ['demo', '--root', demoProject, '--json'], undefined, env);
  assert.equal(demo.code, 0);
  const demoPath = join(home, 'projects', demo.value.data.project_id, 'sessions', `${demo.value.data.session_id}.json`);
  Object.assign(configuration, { projectId, sessionId, bindingId, generation, sessionPath, itemId: '1', question, ask, options,
    demo: { ...demo.value.data, sessionPath: demoPath, before: JSON.parse(await readFile(demoPath, 'utf8')) } });
  const session = await snapshot(configuration);
  assert.equal(session.active_binding_id, bindingId); assert.equal(session.bindings[bindingId].generation, generation);
  assert.equal(session.bindings[bindingId].external_session_id, thread); assert.ok(session.items[configuration.itemId]);
  await writeFile(configuration.bindingPath, JSON.stringify(configuration));
  await writeFile(join(configuration.project, '..', 'journey.json'), JSON.stringify(configuration));
  return { request, connected: connected.value, replay: replay.value, seed, seeded: seeded.value };
}
