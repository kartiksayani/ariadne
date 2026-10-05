import assert from 'node:assert/strict';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
export function literal(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value.split("'").map(part => `'${part}'`).join(',"\'",')})`;
}
export const named = (type, value) => `//XCUIElementType${type}[@title=${literal(value)} or @value=${literal(value)} or @label=${literal(value)}]`;

// One existing Appium/WDA runtime and one session. Changing the AUT through
// activateApp is documented by Mac2; it neither launches nor kills system apps.
export function notificationClient(trace, signal, fetch = globalThis.fetch) {
  let session;
  async function request(method, path, payload, cleanup = false) {
    const response = await fetch(`http://127.0.0.1:4723${path}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: cleanup ? globalThis.AbortSignal.timeout(30000) : globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(30000)]),
    });
    const result = await response.json();
    trace.push({ method, path, request: payload, response: result });
    assert.ok(response.ok && !result.value?.error, `Mac2 command failed: ${JSON.stringify(result)}`);
    return result.value;
  }
  const scoped = (method, path, payload) => request(method, `/session/${session}${path}`, payload);
  const execute = (method, args) => scoped('POST', '/execute/sync', { script: `macos: ${method}`, args: [args] });
  const elements = xpath => scoped('POST', '/elements', { using: 'xpath', value: xpath });
  const attribute = (id, name) => scoped('GET', `/element/${id}/attribute/${name}`);
  async function unique(xpath) {
    const found = await elements(xpath);
    assert.equal(found.length, 1, `Expected one genuine AX target for ${xpath}; inspect retained hierarchy`);
    return found[0][ELEMENT];
  }
  async function click(xpath) {
    const id = await unique(xpath);
    assert.equal(await attribute(id, 'hittable'), 'true', 'Native target is not hittable');
    await execute('click', { elementId: id });
  }
  return {
    async attach(fixture, bundleId) {
      const value = await request('POST', '/session', { capabilities: { alwaysMatch: {
        platformName: 'mac', 'appium:automationName': 'mac2',
        'appium:webDriverAgentMacUrl': 'http://127.0.0.1:10100',
        'appium:bundleId': bundleId, 'appium:appPath': fixture.application,
        'appium:noReset': true, 'appium:skipAppKill': true, 'appium:newCommandTimeout': 120,
      }, firstMatch: [{}] } });
      session = value.sessionId; assert.ok(session, 'Mac2 returned no session');
      // XCTest's default interruption handler can dismiss an authorization
      // alert implicitly. This journey must choose the owner's explicit option.
      await scoped('POST', '/appium/settings', { settings: { useDefaultUiInterruptionsHandling: false } });
    },
    async detach() { if (session) { await request('DELETE', `/session/${session}`, undefined, true); session = undefined; } },
    source: () => scoped('GET', '/source'), elements, attribute, click,
    activate: target => execute('activateApp', target),
    appState: application => execute('queryAppState', { path: application }),
    async type(xpath, text) { const id = await unique(xpath); await click(xpath); await execute('keys', { elementId: id, keys: [...text] }); },
    async tray(title) {
      const status = await unique('//XCUIElementTypeStatusItem');
      if (await attribute(status, 'hittable') !== 'true') await execute('hover', { elementId: status });
      assert.equal(await attribute(status, 'hittable'), 'true', 'Native tray is not hittable');
      await execute('click', { elementId: status });
      await click(`//XCUIElementTypeMenu[XCUIElementTypeMenuItem[@title='Show Ariadne']]/XCUIElementTypeMenuItem[@title=${literal(title)}]`);
    },
  };
}
