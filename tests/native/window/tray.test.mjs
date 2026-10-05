import assert from 'node:assert/strict';
import test from 'node:test';
import { mac2Client } from './run.mjs';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const element = id => ({ [ELEMENT]: id });
const statusPath = '/session/private/element/status/attribute/hittable';
const menuXPath = "//XCUIElementTypeMenu[XCUIElementTypeMenuItem[@title='Show Ariadne']]";
// Reduced transport fixture from the retained AX shape: the closed StatusItem
// is a leaf. These are pure client tests, never physical acceptance evidence.
const openedSource = '<XCUIElementTypeApplication><XCUIElementTypeStatusItem title="1"/><XCUIElementTypeMenu><XCUIElementTypeMenuItem title="Show Ariadne"/></XCUIElementTypeMenu></XCUIElementTypeApplication>';
const hoveredSource = '<XCUIElementTypeApplication><XCUIElementTypeStatusItem title="1"/></XCUIElementTypeApplication>';
const rectangle = { x: 600, y: -27, width: 48, height: 24 };

async function fixture(t, { statusCount = 1, statusHittable = 'true', afterHoverHittable = statusHittable,
  hoverFails = false, menuCount = 1, showHittable = 'true' } = {}) {
  const calls = [], captured = [];
  let clicked = false, hovered = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname;
    const request = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method: options.method, path, request });
    let value;
    if (path === '/session') value = { sessionId: 'private' };
    else if (path === '/session/private/elements') {
      if (request.value === '//XCUIElementTypeStatusItem') value = Array.from({ length: statusCount }, (_, i) => element(i ? `status-${i}` : hovered ? 'revealed-status' : 'status'));
      else if (request.value === menuXPath) {
        assert.ok(clicked, 'Tray descendants must only be queried after the physical status click');
        value = Array.from({ length: menuCount }, (_, i) => element(i ? `tray-${i}` : 'tray'));
      } else if (request.value.includes('Quit Ariadne')) value = [element('ordinary-application-quit')];
      else value = [];
    } else if (path === statusPath || path === '/session/private/element/revealed-status/attribute/hittable') value = hovered ? afterHoverHittable : statusHittable;
    else if (path.endsWith('/rect')) value = rectangle;
    else if (path.endsWith('/attribute/focused')) value = 'false';
    else if (path === '/session/private/execute/sync') {
      if (request.script === 'macos: queryAppState') {
        assert.deepEqual(request.args, [{ path: '/private/fixture/Ariadne.app' }]); value = 4;
      } else if (request.script === 'macos: hover') {
        assert.deepEqual(request.args, [{ elementId: 'status' }]);
        if (hoverFails) throw new Error('Physical hover failed');
        hovered = true; value = null;
      } else {
        assert.equal(request.script, 'macos: click');
        if (['status', 'revealed-status'].includes(request.args[0].elementId)) clicked = true;
        value = null;
      }
    } else if (path === '/session/private/source') {
      assert.ok(clicked || hovered); value = clicked ? openedSource : hoveredSource;
    } else if (path === '/session/private/element/tray/elements') {
      const title = request.value.match(/^\.\/XCUIElementTypeMenuItem\[@title='(.*)'\]$/)?.[1];
      assert.ok(['Show Ariadne', 'Pin', 'Quit Ariadne'].includes(title), 'Actions must stay within the identified tray menu');
      value = [element(title)];
    } else if (path.endsWith('/attribute/hittable')) {
      value = path.includes('/Show%20Ariadne/') || path.includes('/Show Ariadne/') ? showHittable : 'true';
    } else if (path.endsWith('/selected')) value = true;
    else throw new Error(`Unexpected pure-test request: ${options.method} ${path}`);
    return globalThis.Response.json({ value });
  });
  const client = mac2Client([], new globalThis.AbortController().signal, async (source, stage) => {
    captured.push(source); calls.push({ capture: stage });
  });
  await client.attach({ application: '/private/fixture/Ariadne.app' }, 'com.ariadne.desktop');
  return { client, calls, captured };
}

test('clicks the unique hittable status leaf before capturing and inspecting its opened menu', async t => {
  const { client, calls, captured } = await fixture(t);
  await client.openTray();
  assert.deepEqual(captured, [openedSource]);
  assert.deepEqual(calls.slice(1).map(call => call.capture ? 'capture' : `${call.method} ${call.path}`), [
    'POST /session/private/elements', 'GET /session/private/element/status/rect',
    'GET /session/private/element/status/attribute/focused', `GET ${statusPath}`, 'POST /session/private/execute/sync',
    'GET /session/private/source', 'capture', 'POST /session/private/elements',
    'POST /session/private/element/tray/elements', 'GET /session/private/element/Show%20Ariadne/attribute/hittable',
  ]);
});

test('refuses ambiguous status items without hovering, clicking or capturing', async t => {
  const { client, calls, captured } = await fixture(t, { statusCount: 2 });
  await assert.rejects(client.openTray(), /Expected one genuine AX element/);
  assert.equal(calls.some(call => call.path?.endsWith('/execute/sync')), false);
  assert.deepEqual(captured, []);
});

test('records actual App state, negative status frame, focus and hittability without interaction', async t => {
  const { client, calls } = await fixture(t, { statusHittable: 'false' });
  assert.deepEqual(await client.statusState('/private/fixture/Ariadne.app'), {
    appState: 4, elementId: 'status', rectangle, focused: 'false', hittable: 'false',
  });
  assert.deepEqual(calls.filter(call => call.path?.endsWith('/execute/sync')).map(call => call.request.script), ['macos: queryAppState']);
});

test('one genuine hover retains AX but does not click a status item that stays non-hittable', async t => {
  const { client, calls, captured } = await fixture(t, { statusHittable: 'false' });
  await assert.rejects(client.openTray(), /not hittable after one physical hover/);
  assert.deepEqual(captured, [hoveredSource]);
  assert.deepEqual(calls.filter(call => call.path?.endsWith('/execute/sync')).map(call => call.request), [
    { script: 'macos: hover', args: [{ elementId: 'status' }] },
  ]);
  assert.equal(calls.filter(call => call.request?.value === '//XCUIElementTypeStatusItem').length, 2);
});

test('clicks only the freshly observed status element when genuine hover makes it hittable', async t => {
  const { client, calls, captured } = await fixture(t, { statusHittable: 'false', afterHoverHittable: 'true' });
  await client.openTray();
  assert.deepEqual(captured, [hoveredSource, openedSource]);
  assert.deepEqual(calls.filter(call => call.path?.endsWith('/execute/sync')).map(call => call.request), [
    { script: 'macos: hover', args: [{ elementId: 'status' }] },
    { script: 'macos: click', args: [{ elementId: 'revealed-status' }] },
  ]);
  const clicked = calls.findIndex(call => call.request?.script === 'macos: click');
  const rechecked = calls.findIndex(call => call.path === '/session/private/element/revealed-status/attribute/hittable');
  assert.ok(rechecked >= 0 && clicked > rechecked);
});

test('a failed physical hover does not fall through to click', async t => {
  const { client, calls } = await fixture(t, { statusHittable: 'false', hoverFails: true });
  await assert.rejects(client.openTray(), /Physical hover failed/);
  assert.equal(calls.some(call => call.request?.script === 'macos: click'), false);
});

test('retains post-click source but refuses a missing or ambiguous menu or hidden Show action', async t => {
  for (const options of [{ menuCount: 0 }, { menuCount: 2 }, { showHittable: 'false' }]) {
    await t.test(JSON.stringify(options), async child => {
      const { client, calls, captured } = await fixture(child, options);
      await assert.rejects(client.openTray(), /Expected one genuine AX element|not hittable/);
      assert.deepEqual(captured, [openedSource]);
      assert.equal(calls.filter(call => call.path?.endsWith('/execute/sync')).length, 1);
    });
  }
});

test('scopes checked Pin and physical Quit to the opened tray, never ordinary application Quit', async t => {
  const { client, calls } = await fixture(t);
  await assert.rejects(client.choose('Quit Ariadne'), /Open the genuine tray menu/);
  await client.openTray();
  assert.equal(await client.pinSelected(), true);
  await client.choose('Quit Ariadne');
  const clicks = calls.filter(call => call.path?.endsWith('/execute/sync'));
  assert.deepEqual(clicks.map(call => call.request.args[0].elementId), ['status', 'Quit Ariadne']);
  assert.equal(calls.some(call => call.path === '/session/private/elements' && call.request.value.includes('Quit Ariadne')), false);
  await assert.rejects(client.choose('Show Ariadne'), /Open the genuine tray menu/);
});
