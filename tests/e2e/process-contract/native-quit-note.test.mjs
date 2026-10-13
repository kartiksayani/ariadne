import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { acknowledgeQuitNote, quitNoteScript, selectQuitNote } from '../../../scripts/native-quit-note.mjs';

const pid = 4242;
const message = 'Host work already sent can continue after Ariadne quits.';
const informative = 'Queued, unsent inputs wait until you reopen Ariadne.';
const dialog = () => ({ texts: [message, informative], buttons: [{ name: 'OK', enabled: true, actions: ['AXPress'] }] });

// Run the actual JXA adapter with an observed native hierarchy fixture, retaining
// whether a native action was requested. No App, AX permission or service calls.
function nativeFixture({ dialogs = [dialog()], actualPid = pid, trusted = true, permission = 0, serviceRunning = true, sameNamePeer = false, processCount = 1 } = {}) {
  let pressed = 0, applicationCalls = 0, permissionChecks = 0;
  const accesses = [];
  const collection = (elements, path) => {
    // Evaluated collections lose their anchored specifiers in JXA. Make the
    // mock reject that operation even when only one process happens to exist.
    const query = () => assert.fail(`Materialized native handles at ${path}`);
    Object.defineProperty(query, 'length', { get: () => { accesses.push({ pid, path }); return elements.length; } });
    query.at = index => { accesses.push({ pid, path }); assert.ok(index >= 0 && index < elements.length); return elements[index]; };
    query.byName = name => { accesses.push({ pid, path }); return elements.find(element => element.name() === name); };
    return query;
  };
  const children = (elements, path) => collection(elements, `${path}.uiElements`);
  const windows = dialogs.map(dialog => {
    const texts = dialog.texts.map(value => ({ role: () => 'AXStaticText', value: () => value, uiElements: children([], 'text') }));
    const buttons = dialog.buttons.map(button => {
      const actions = collection(button.actions.map(name => ({ name: () => name,
        perform: () => { assert.equal(name, 'AXPress'); pressed++; } })), 'button.actions');
      return { role: () => 'AXButton', name: () => button.name, enabled: () => button.enabled, actions, uiElements: children([], 'button') };
    });
    // A group forces the adapter to retain the PID anchor through descendants.
    const group = { role: () => 'AXGroup', uiElements: children([...texts, ...buttons], 'group') };
    return { subrole: () => 'AXDialog', uiElements: children([group], 'window') };
  });
  const processes = [{ name: 'Ariadne', unixId: actualPid, windows }];
  if (sameNamePeer) processes.unshift({ name: 'Ariadne', unixId: pid + 1, windows: [] });
  const context = {
    ObjC: { import() {}, bindFunction() {} },
    $: {
      AXIsProcessTrustedWithOptions: options => { assert.equal(options, null); return trusted; },
      NSRunningApplication: { runningApplicationsWithBundleIdentifier: id => {
        assert.equal(id, 'com.apple.systemevents');
        // The JXA bridge returns C longs as strings, including the truthy "0".
        return { count: String(Number(serviceRunning)), objectAtIndex: index => {
          assert.equal(index, 0);
          assert.ok(serviceRunning, 'must not index an empty native application list');
          return { processIdentifier: 17 };
        } };
      } },
      NSAppleEventDescriptor: { descriptorWithProcessIdentifier: service => { assert.equal(service, 17); return { aeDesc: 'descriptor' }; } },
      AEDeterminePermissionToAutomateTarget: (address, eventClass, eventId, ask) => {
        assert.equal(address, 'descriptor'); assert.equal(eventClass, 0x2a2a2a2a); assert.equal(eventId, eventClass); assert.equal(ask, false);
        permissionChecks++; return permission;
      },
    },
    Application: name => {
      assert.equal(name, 'System Events'); applicationCalls++;
      return { applicationProcesses: { whose: selector => {
        assert.equal(selector.unixId, pid);
        const matching = processes.filter(process => process.unixId === actualPid).slice(0, processCount);
        if (processCount > 1) matching.push(matching[0]);
        return collection(matching.map(process => ({ unixId: () => process.unixId,
          windows: collection(process.windows, `unixId=${selector.unixId}.windows`) })), `unixId=${selector.unixId}`);
      } } };
    },
  };
  return {
    run: mode => JSON.parse(runInNewContext(`${quitNoteScript}\nrun(${JSON.stringify([mode, String(pid)])})`, context)),
    effects: () => ({ pressed, applicationCalls, permissionChecks }),
    accesses: () => accesses,
  };
}

test('owned actual dialog text and sole enabled OK produce a native AXPress receipt', () => {
  const native = nativeFixture();
  assert.deepEqual(native.run('inspect'), { pid, message, informative, button: 'OK', action: 'AXPress', pressed: false });
  assert.equal(native.effects().pressed, 0);
  assert.deepEqual(native.run('press'), { pid, message, informative, button: 'OK', action: 'AXPress', pressed: true });
  assert.equal(native.effects().pressed, 1);
});

test('PID-filtered specifiers survive every window, nested element and action access with one or two identically named apps', () => {
  for (const sameNamePeer of [false, true]) {
    const native = nativeFixture({ sameNamePeer });
    assert.equal(native.run('press').pressed, true);
    assert.equal(native.effects().pressed, 1);
    const accesses = native.accesses();
    assert.ok(accesses.every(access => access.pid === pid));
    for (const path of [`unixId=${pid}`, `unixId=${pid}.windows`, 'window.uiElements', 'group.uiElements', 'button.actions'])
      assert.ok(accesses.some(access => access.path === path), `Expected anchored traversal at ${path}`);
  }
  for (const processCount of [0, 2]) {
    const native = nativeFixture({ processCount });
    assert.throws(() => native.run('press'), /Owned native process is unavailable/);
    assert.equal(native.effects().pressed, 0);
  }
});

test('wrong PID, extra or duplicate note text, multiple dialogs, extra buttons and unavailable OK never press', () => {
  assert.throws(() => selectQuitNote({ pid: pid + 1, dialogs: [dialog()] }, pid), /another PID/);
  const wrongText = dialog(); wrongText.texts[1] = 'An unrelated dialog';
  const extraText = dialog(); extraText.texts.push('Another notification');
  const duplicateText = dialog(); duplicateText.texts.push(message);
  const extraButtons = dialog(); extraButtons.buttons.push({ name: 'Cancel', enabled: true, actions: ['AXPress'] });
  const disabled = dialog(); disabled.buttons[0].enabled = false;
  const wrongButton = dialog(); wrongButton.buttons[0].name = 'Allow';
  const missingAction = dialog(); missingAction.buttons[0].actions = [];
  for (const configuration of [
    { actualPid: pid + 1 }, { dialogs: [wrongText] }, { dialogs: [extraText] }, { dialogs: [duplicateText] }, { dialogs: [dialog(), dialog()] },
    { dialogs: [extraButtons] }, { dialogs: [disabled] }, { dialogs: [wrongButton] }, { dialogs: [missingAction] },
  ]) {
    const native = nativeFixture(configuration);
    assert.throws(() => native.run('press'));
    assert.equal(native.effects().pressed, 0);
  }
  const absent = nativeFixture({ dialogs: [] });
  assert.equal(absent.run('press'), null); assert.equal(absent.effects().pressed, 0);
  const reversed = dialog(); reversed.texts.reverse();
  assert.equal(nativeFixture({ dialogs: [reversed] }).run('press').pressed, true);
});

test('missing Accessibility or Automation fails before UI observation without requesting consent', () => {
  const untrusted = nativeFixture({ trusted: false });
  assert.throws(() => untrusted.run('preflight'), /Accessibility.*no prompt/);
  assert.deepEqual(untrusted.effects(), { pressed: 0, applicationCalls: 0, permissionChecks: 0 });
  for (const permission of [-1743, -1744]) {
    const denied = nativeFixture({ permission });
    assert.throws(() => denied.run('preflight'), /automation.*no prompt/);
    assert.deepEqual(denied.effects(), { pressed: 0, applicationCalls: 0, permissionChecks: 1 });
  }
  const absent = nativeFixture({ serviceRunning: false });
  assert.deepEqual(absent.run('preflight'), { serviceRunning: false });
  assert.deepEqual(absent.effects(), { pressed: 0, applicationCalls: 0, permissionChecks: 0 });
  for (const mode of ['inspect', 'press']) {
    assert.throws(() => absent.run(mode), /System Events is unavailable during native Quit acknowledgement/);
    assert.deepEqual(absent.effects(), { pressed: 0, applicationCalls: 0, permissionChecks: 0 });
  }
});

test('acknowledgement refreshes prerequisites at owned Quit and revalidates the actual dialog before pressing', async () => {
  const owned = { pid, exe: '/owned/Ariadne', birth: 'owned birth' }, nonce = 'owned Quit';
  for (const changed of [false, true]) {
    let refreshed = false;
    const actual = nativeFixture(), replacement = dialog();
    replacement.texts[1] = 'A different dialog';
    const changedNative = nativeFixture({ dialogs: [replacement] });
    const acknowledge = runInNewContext(`(${acknowledgeQuitNote.toString()})`, {
      join, readFile: async path => JSON.stringify(path.endsWith('launcher.json') ? { pid: 10 } : { pid, nonce }),
      identity: () => owned, observeOwned: async () => owned, alive: () => true,
      preflightQuitNote: async () => { refreshed = true; },
      native: (mode, target) => {
        assert.equal(target, pid);
        assert.ok(refreshed, 'refresh prerequisites before observing the owned Quit dialog');
        return (mode === 'press' && changed ? changedNative : actual).run(mode);
      },
    });
    const result = acknowledge('/owned', owned.exe, nonce, owned);
    if (changed) {
      await assert.rejects(result, /Unexpected native Quit note text/);
      assert.equal(actual.effects().pressed + changedNative.effects().pressed, 0);
    } else {
      assert.equal((await result).pressed, true);
      assert.equal(actual.effects().pressed, 1);
    }
  }
});

test('request nonce/PID, process birth and launcher ancestry gate acknowledgement before native access', async () => {
  const root = await mkdtemp('/private/tmp/ariadne-note-witness-');
  const owned = { pid, exe: '/owned/Ariadne', birth: 'owned birth' }, nonce = 'owned-native-launch';
  const save = (name, value) => writeFile(join(root, name), JSON.stringify(value));
  const acknowledge = runInNewContext(`(${acknowledgeQuitNote.toString()})`, {
    join, readFile,
    identity: () => owned,
    observeOwned: async (_root, _binary, _nonce, launcherPid) => {
      if (launcherPid !== 10) throw new Error('Process is outside the owned launcher ancestry');
      return owned;
    },
    preflightQuitNote: async () => {}, native: () => assert.fail('Rejected witness must not access native UI'),
  });
  const signal = new globalThis.AbortController().signal;
  try {
    await save('launcher.json', { pid: 10 });
    await save('startup.json', { pid: owned.pid, nonce });
    for (const request of [{ pid: owned.pid + 1, nonce }, { pid: owned.pid, nonce: 'stale' }]) {
      await save('quit-request.json', request);
      await assert.rejects(acknowledge(root, owned.exe, nonce, owned, signal), /request identity mismatch/);
    }
    await save('quit-request.json', { pid: owned.pid, nonce });
    await assert.rejects(acknowledge(root, owned.exe, nonce, { ...owned, birth: 'stale birth' }, signal), /changed native process identity/);
    await save('launcher.json', { pid: 2 });
    await assert.rejects(acknowledge(root, owned.exe, nonce, owned, signal), /outside the owned launcher ancestry/);
    const interrupted = new globalThis.AbortController(); interrupted.abort(new Error('Owned runner cancelled'));
    await assert.rejects(acknowledge(root, owned.exe, nonce, owned, interrupted.signal), /Owned runner cancelled/);
  } finally { await rm(root, { recursive: true }); }
});
