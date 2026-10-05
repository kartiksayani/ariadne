import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notificationClient, literal, named } from './mac2.mjs';
import { arrivalRequest, assertClick, assertDeniedAnswer } from './assertions.mjs';
import { validateOptions } from './run.mjs';
import { cliRequest } from '../../../apps/desktop/tests/e2e/scripted-provider.mjs';

const route = { project_id: 'project', session_id: 'session', item_id: '2' };
const baseline = { primary: { pid: 123, birth: 'same' }, ownership: { socket: { ino: 7 }, leaseHeld: true }, sessionSha256: 'unchanged' };
function clicked() {
  const session = { project_id: route.project_id, session_id: route.session_id };
  return { ...globalThis.structuredClone(baseline), preferences: { global: { selected_navigation: { kind: 'session', session } },
    sessions: [{ session, tab_open: true, selected_item_id: '2' }] }, visible: true, detailItem: 'Item 2', questionVisible: true };
}

test('notification click requires exact route, current detail and the same unchanged owned process', () => {
  assert.doesNotThrow(() => assertClick(baseline, clicked(), route));
  for (const mutate of [
    value => { value.primary.pid++; }, value => { value.primary.birth = 'reused'; },
    value => { value.ownership.socket.ino++; }, value => { value.ownership.leaseHeld = false; },
    value => { value.sessionSha256 = 'changed'; }, value => { value.visible = false; },
    value => { value.detailItem = 'Item 1'; }, value => { value.questionVisible = false; },
    value => { value.preferences.global.selected_navigation.session.project_id = 'other'; },
    value => { value.preferences.sessions[0].selected_item_id = '1'; },
    value => { value.preferences.sessions.push(globalThis.structuredClone(value.preferences.sessions[0])); },
  ]) { const value = clicked(); mutate(value); assert.throws(() => assertClick(baseline, value, route)); }
});

test('permission scenario must be explicit and package paths absolute', () => {
  const options = { bundle: '/private/Ariadne.app', cli: '/private/ariadne', releaseEvidence: '/private/evidence' };
  for (const permission of ['allow', 'deny', 'existing']) assert.doesNotThrow(() => validateOptions({ ...options, permission }));
  for (const permission of [undefined, '', 'reset', 'true']) assert.throws(() => validateOptions({ ...options, permission }));
  for (const name of Object.keys(options)) assert.throws(() => validateOptions({ ...options, [name]: 'relative', permission: 'deny' }));
});

test('native selectors treat authored labels as data, including both quote types', () => {
  assert.equal(literal('Simple'), "'Simple'"); assert.equal(literal("Don't Allow"), '"Don\'t Allow"');
  assert.equal(literal('It\'s "quoted"'), `concat('It',"'",'s "quoted"')`);
  assert.equal(named('Button', 'Send'), "//XCUIElementTypeButton[@title='Send' or @value='Send' or @label='Send']");
});

function transport(responses, trace, signal = new globalThis.AbortController().signal) {
  const requests = [];
  const client = notificationClient(trace, signal, async (url, options) => {
    requests.push({ url, ...options, body: options.body && JSON.parse(options.body) });
    const value = responses.shift(); assert.notEqual(value, undefined, 'Unexpected native boundary call');
    return { ok: !value?.error, json: async () => ({ value }) };
  });
  return { client, requests };
}
const fixture = { application: '/private/Ariadne.app' };
const found = id => ({ 'element-6066-11e4-a52e-4f735466cecf': id });

test('one Mac2 session preserves system apps and disables implicit permission handling before actions', async () => {
  const trace = [], { client, requests } = transport([{ sessionId: 'one' }, null, null, [found('body')], 'true', null, null], trace);
  await client.attach(fixture, 'com.ariadne');
  await client.activate({ bundleId: 'com.apple.notificationcenterui' });
  await client.click(named('StaticText', 'A question is waiting for your answer.'));
  await client.detach();
  assert.equal(requests[0].body.capabilities.alwaysMatch['appium:skipAppKill'], true);
  assert.equal(requests[0].body.capabilities.alwaysMatch['appium:noReset'], true);
  assert.deepEqual(requests[1].body, { settings: { useDefaultUiInterruptionsHandling: false } });
  assert.deepEqual(requests[2].body, { script: 'macos: activateApp', args: [{ bundleId: 'com.apple.notificationcenterui' }] });
  assert.deepEqual(requests[5].body, { script: 'macos: click', args: [{ elementId: 'body' }] });
  assert.equal(requests.at(-1).method, 'DELETE'); assert.equal(trace.length, requests.length);
});

test('missing, ambiguous or unhittable native targets never receive a click', async () => {
  for (const [targets, hittable] of [[[], undefined], [[found('a'), found('b')], undefined], [[found('a')], 'false']]) {
    const responses = [{ sessionId: 'one' }, null, targets, ...(hittable === undefined ? [] : [hittable])];
    const { client, requests } = transport(responses, []);
    await client.attach(fixture, 'com.ariadne');
    await assert.rejects(client.click(named('Button', 'Allow')));
    assert.ok(!requests.some(request => request.body?.script === 'macos: click'));
  }
});

test('cached App control visibility is observable while Notification Center remains AUT', async () => {
  const { client, requests } = transport([{ sessionId: 'one' }, null, [found('original-close')], null, 'true'], []);
  await client.attach(fixture, 'com.ariadne');
  const [close] = await client.elements("//XCUIElementTypeButton[@identifier='_XCUI:CloseWindow']");
  await client.activate({ bundleId: 'com.apple.notificationcenterui' });
  assert.equal(await client.attribute(close['element-6066-11e4-a52e-4f735466cecf'], 'hittable'), 'true');
  assert.ok(requests.at(-1).url.endsWith('/element/original-close/attribute/hittable'));
  assert.equal(requests.filter(request => request.body?.script === 'macos: activateApp').length, 1);
});

test('permission denial evidence requires one actual correlated saved answer and host admission', () => {
  const configuration = { itemId: '1', options: [{ id: 'saved' }] }, text = 'The full denied-permission answer';
  const saved = { items: { 1: { question_revision: 3 } },
    inputs: { input: { id: 'input', kind: 'answer', target: { item_id: '1' }, answer_id: 'answer',
      payload: { text }, attempts: [{ formatted_payload: 'exact-host-payload' }] } },
    answers: [{ id: 'answer', text, question_revision: 3, selected_option_id: 'saved' }] };
  const queued = [{ inputId: 'input', payload: 'exact-host-payload' }];
  assert.doesNotThrow(() => assertDeniedAnswer(saved, text, configuration, queued));
  for (const mutate of [
    value => { value.answers = []; }, value => { value.answers[0].question_revision--; },
    value => { value.answers[0].selected_option_id = 'other'; }, value => { value.inputs.input.kind = 'reply'; },
    value => { value.inputs.input.target.item_id = '2'; }, value => { value.inputs.copy = { ...value.inputs.input }; },
  ]) { const value = globalThis.structuredClone(saved); mutate(value); assert.throws(() => assertDeniedAnswer(value, text, configuration, queued)); }
  assert.throws(() => assertDeniedAnswer(saved, text, configuration, []));
  assert.throws(() => assertDeniedAnswer(saved, text, configuration, [{ ...queued[0], payload: 'wrong' }]));
});

const cli = process.env.ARIADNE_FIXTURE_TEST_CLI;
test('new notification arrival crosses the real CLI wire barrier without rewriting disconnected demo data', { skip: !cli }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-notification-wire-'));
  try {
    const project = join(root, 'project'), home = join(root, 'data'); await mkdir(project); await mkdir(home, { mode: 0o700 });
    const env = { ...process.env, ARIADNE_HOME: home };
    const demo = await cliRequest(cli, ['demo', '--root', project, '--json'], undefined, env); assert.equal(demo.code, 0);
    const path = join(project, '.ariadne/sessions', `${demo.value.data.session_id}.json`), before = await readFile(path);
    const session = JSON.parse(before), binding = session.bindings[session.active_binding_id];
    const result = await cliRequest(cli, ['apply', '--binding', binding.id, '--generation', binding.generation, '--json-stdin', '--json'], arrivalRequest(binding.id, 'native café “private”'), env);
    assert.equal(result.code, 3); assert.equal(result.value.error.code, 'binding_mismatch');
    assert.equal(result.value.error.message, 'This binding is not the selected connected route');
    assert.deepEqual(await readFile(path), before, 'Disconnected wire validation does not claim native publication');
  } finally { await rm(root, { recursive: true, force: true }); }
});
