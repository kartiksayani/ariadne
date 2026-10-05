import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { acknowledgeQuitNote, quitNoteScript, selectQuitNote } from '../../../scripts/native-quit-note.mjs';
import { identity } from '../../../scripts/run-native-e2e.mjs';

const pid = 4242;
const message = 'Host work already sent can continue after Ariadne quits.';
const informative = 'Queued, unsent inputs wait until you reopen Ariadne.';
const dialog = () => ({ texts: [message, informative], buttons: [{ name: 'OK', enabled: true, actions: ['AXPress'] }] });

// Run the actual JXA adapter with an observed native hierarchy fixture, retaining
// whether a native action was requested. No App, AX permission or service calls.
function nativeFixture({ dialogs = [dialog()], actualPid = pid, trusted = true, permission = 0, serviceRunning = true } = {}) {
  let pressed = 0, applicationCalls = 0, permissionChecks = 0;
  const windows = dialogs.map(dialog => {
    const texts = dialog.texts.map(value => ({ role: () => 'AXStaticText', value: () => value }));
    const buttons = dialog.buttons.map(button => {
      const actions = () => button.actions.map(name => ({ name: () => name }));
      actions.byName = name => ({ perform: () => { assert.equal(name, 'AXPress'); pressed++; } });
      return { role: () => 'AXButton', name: () => button.name, enabled: () => button.enabled, actions };
    });
    return { subrole: () => 'AXDialog', entireContents: () => [...texts, ...buttons] };
  });
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
        return () => [{ unixId: () => actualPid, windows: () => windows }];
      } } };
    },
  };
  return {
    run: mode => JSON.parse(runInNewContext(`${quitNoteScript}\nrun(${JSON.stringify([mode, String(pid)])})`, context)),
    effects: () => ({ pressed, applicationCalls, permissionChecks }),
  };
}

test('owned actual dialog text and sole enabled OK produce a native AXPress receipt', () => {
  const native = nativeFixture();
  assert.deepEqual(native.run('inspect'), { pid, message, informative, button: 'OK', action: 'AXPress', pressed: false });
  assert.equal(native.effects().pressed, 0);
  assert.deepEqual(native.run('press'), { pid, message, informative, button: 'OK', action: 'AXPress', pressed: true });
  assert.equal(native.effects().pressed, 1);
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
});

test('request nonce/PID, process birth and launcher ancestry gate acknowledgement before native access', async () => {
  const root = await mkdtemp('/private/tmp/ariadne-note-witness-');
  const owned = identity(process.pid), nonce = 'owned-native-launch';
  const save = (name, value) => writeFile(join(root, name), JSON.stringify(value));
  const signal = new globalThis.AbortController().signal;
  try {
    await save('launcher.json', { pid: process.ppid });
    await save('startup.json', { pid: owned.pid, nonce });
    for (const request of [{ pid: owned.pid + 1, nonce }, { pid: owned.pid, nonce: 'stale' }]) {
      await save('quit-request.json', request);
      await assert.rejects(acknowledgeQuitNote(root, owned.exe, nonce, owned, signal), /request identity mismatch/);
    }
    await save('quit-request.json', { pid: owned.pid, nonce });
    await assert.rejects(acknowledgeQuitNote(root, owned.exe, nonce, { ...owned, birth: 'stale birth' }, signal), /changed native process identity/);
    await save('launcher.json', { pid: 2 });
    await assert.rejects(acknowledgeQuitNote(root, owned.exe, nonce, owned, signal), /outside the owned launcher ancestry/);
    const interrupted = new globalThis.AbortController(); interrupted.abort(new Error('Owned runner cancelled'));
    await assert.rejects(acknowledgeQuitNote(root, owned.exe, nonce, owned, interrupted.signal), /Owned runner cancelled/);
  } finally { await rm(root, { recursive: true }); }
});
