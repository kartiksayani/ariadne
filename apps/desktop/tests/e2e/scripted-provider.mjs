import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
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
async function optional(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
const applyRequest = operations => ({ op_id: randomUUID(), source_input_id: null, attempt_id: null,
  expected_item_revisions: {}, expected_topic_revisions: {}, summary: '', operations, input_result: null });

// This replaces only the pinned existing provider endpoint/executable. Every
// domain read, connection, owner mutation and explicit reply/result is real CLI/Core/Store.
export async function startScriptedProvider(root, cli, evidence, env) {
  const provider = join(root, 'provider'), project = join(root, 'project');
  await mkdir(provider, { recursive: true }); await mkdir(project);
  const socket = join(provider, 'daemon.sock'), executable = join(provider, 'codex');
  const queuedPath = join(provider, 'queued.json'), completePath = join(provider, 'complete.json');
  const bindingPath = join(provider, 'binding.json'), calls = [];
  const executableSource = `#!${process.execPath}\nimport{writeFileSync,appendFileSync,renameSync}from'node:fs';\nconst args=process.argv.slice(2);\nif(args.length===1&&args[0]==='--version'){appendFileSync(${JSON.stringify(join(provider, 'versions.jsonl'))},'version\\n');console.log('codex-cli 0.160.0');}\nelse if(args.length===7&&args[0]==='queue'&&args[1]==='--remote'&&args[2]===${JSON.stringify(`unix://${socket}`)}&&args[3]==='--thread'&&args[4]===${JSON.stringify(thread)}&&args[5]==='--message'&&/^\\[ARIADNE_INPUT:[0-9a-f-]{36}:[0-9a-f-]{36}\\]\\n/.test(args[6])){writeFileSync(${JSON.stringify(queuedPath + '.tmp')},JSON.stringify({payload:args[6],args:args.slice(0,6)}));renameSync(${JSON.stringify(queuedPath + '.tmp')},${JSON.stringify(queuedPath)});}\nelse{process.exitCode=3;}\n`;
  // The fixture executable is a module even without a .mjs extension.
  await writeFile(join(provider, 'package.json'), '{"type":"module"}');
  await writeFile(executable, executableSource); await chmod(executable, 0o700);
  const fixtures = new URL('../../../../contracts/providers/codex/0.160.0/fixtures/', import.meta.url);
  const load = async name => JSON.parse(await readFile(new URL(name, fixtures), 'utf8'));
  let finish, failure;
  async function turns() {
    const queued = await optional(queuedPath);
    if (!queued) return { data: [], nextCursor: null, backwardsCursor: null };
    const complete = await optional(completePath);
    if (complete && !finish) {
      finish = (async () => {
        const configuration = await optional(bindingPath);
        assert.ok(configuration, 'Only the saved canonical B/G may publish a result');
        const session = await snapshot(configuration);
        const input = Object.values(session.inputs).find(input => input.attempts.some(attempt => queued.payload === attempt.formatted_payload));
        assert.ok(input, 'Queue payload must identify the actual persisted attempt');
        const attempt = input.attempts.find(attempt => queued.payload === attempt.formatted_payload);
        const owner = session.messages.find(message => message.id === input.message_id);
        const request = { ...applyRequest([{ op: 'reply', ref: 'native-reply', item: { id: configuration.itemId }, text: complete.reply, round_id: null }]),
          source_input_id: input.id, attempt_id: attempt.id,
          expected_item_revisions: { [configuration.itemId]: session.items[configuration.itemId].revision },
          input_result: { outcome: 'answered', explanation: 'Explicit scripted provider result', reply_refs: [{ ref: 'native-reply' }], followup_item_refs: [], handled_through_message_number: owner.number } };
        const applied = await cliRequest(cli, ['apply', '--binding', configuration.bindingId, '--generation', configuration.generation, '--json-stdin'], request, env);
        assert.equal(applied.code, 0); assert.equal(applied.value.session_id, configuration.sessionId);
        await writeFile(join(evidence, 'agent-apply.json'), JSON.stringify({ request, receipt: applied.value }, null, 2));
        return applied;
      })();
    }
    if (finish) await finish;
    const result = await load('turns-response.json');
    const turn = result.data[0];
    turn.id = 'scripted-native-turn'; turn.status = complete ? 'completed' : 'inProgress';
    turn.completedAt = complete ? Math.floor(Date.now() / 1000) : null;
    turn.items = [{ type: 'userMessage', id: 'scripted-native-owner', clientId: 'scripted-native-client', content: [{ type: 'text', text: queued.payload, text_elements: [] }] }];
    return { ...result, data: [turn] };
  }
  const server = http.createServer();
  const websocket = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, stream, head) => websocket.handleUpgrade(request, stream, head, client => websocket.emit('connection', client)));
  websocket.on('connection', client => client.on('message', async bytes => {
    try {
      const request = JSON.parse(bytes.toString()); calls.push({ method: request.method, params: request.params });
      let result;
      switch (request.method) {
        case 'initialized': return;
        case 'initialize': result = await load('initialize-response.json'); result.codexHome = provider; break;
        case 'thread/read':
          result = await load('read-response.json'); result.thread.id = thread; result.thread.sessionId = thread; result.thread.cwd = project; break;
        case 'thread/loaded/list': result = { data: [thread], nextCursor: null }; break;
        case 'thread/queue/list': result = { data: [], nextCursor: null }; break;
        case 'thread/turns/list': result = await turns(); break;
        default: throw new Error(`Unexpected provider operation ${request.method}`);
      }
      client.send(JSON.stringify({ id: request.id, result }));
    } catch (error) { failure ||= error; client.close(); }
  }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await chmod(socket, 0o600);
  const configuration = { cli, project, provider, socket, executable, queuedPath, completePath, bindingPath, thread,
    appArgs: ['--codex-executable', executable, '--codex-home', provider, '--codex-endpoint', socket] };
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
  const sessionPath = join(configuration.project, '.ariadne/sessions', `${sessionId}.json`);
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
  const read = receipt.data.setup_instruction.split('\n').find(line => line.startsWith('Use ariadne read '));
  assert.ok(read, 'Saved setup contains pasteable canonical read arguments');
  const readArgs = read.slice('Use ariadne '.length).replace(/\.$/, '').split(/\s+/);
  assert.equal((await cliRequest(configuration.cli, readArgs, undefined, env)).code, 0);
  const seed = applyRequest([
    { op: 'topic.add', ref: 'native-topic', name: 'Native provider journey' },
    { op: 'item.add', ref: 'native-item', topic: { ref: 'native-topic' }, parent: null, question: 'Reply to this native owner message', type: 'task', status: 'open', owner: { kind: 'me' }, ask: null, options: null, note: null, links: null, outcome: null, why: null, replaced_by: null, source_round_id: null },
  ]);
  const apply = receipt.data.setup_instruction.split('\n').find(line => line.startsWith('Publish full item replies with ariadne apply '));
  assert.ok(apply, 'Saved setup contains pasteable canonical apply arguments');
  const applyArgs = apply.slice('Publish full item replies with ariadne '.length).split('. Use explicit')[0].split(/\s+/);
  const seeded = await cliRequest(configuration.cli, applyArgs, seed, env);
  assert.equal(seeded.code, 0);
  Object.assign(configuration, { projectId, sessionId, bindingId, generation, sessionPath, itemId: '1' });
  const session = await snapshot(configuration);
  assert.equal(session.active_binding_id, bindingId); assert.equal(session.bindings[bindingId].generation, generation);
  assert.equal(session.bindings[bindingId].external_session_id, thread); assert.ok(session.items[configuration.itemId]);
  await writeFile(configuration.bindingPath, JSON.stringify(configuration));
  return { request, connected: connected.value, replay: replay.value, seed, seeded: seeded.value };
}
