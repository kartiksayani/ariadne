import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { acknowledgeQuitNote, isTransientNativeError, isVanishedElement, noteEvidence, quitNoteScript, selectQuitNote } from '../../../scripts/native-quit-note.mjs';

const pid = 4242;
const message = 'Host work already sent can continue after Ariadne quits.';
const informative = 'Queued, unsent inputs wait until you reopen Ariadne.';
const dialog = () => ({ texts: [message, informative], buttons: [{ name: 'OK', enabled: true, actions: ['AXPress'] }] });

// Run the actual JXA adapter with an observed native hierarchy fixture, retaining
// whether a native action was requested. No App, AX permission or service calls.
// `vanish` names one native read that raises the error macOS gives when the live
// AX tree changes under the walk (-1719 for an index, -1728 for an object); it
// stays vanished, so each run observes the same half-read tree. `vanish: 'other'`
// raises an unrelated error. `pressFailures` makes the first N AXPress performs
// raise -1728, as when the dialog is dismissed between the inspect and the press.
function nativeFixture({ dialogs = [dialog()], actualPid = pid, trusted = true, permission = 0, serviceRunning = true, sameNamePeer = false, processCount = 1, vanish, pressFailures = 0 } = {}) {
  let pressed = 0, applicationCalls = 0, permissionChecks = 0, failedPresses = 0;
  const accesses = [];
  const gone = (kind, value, code = '-1719') => vanish === kind || (vanish === 'other' && kind === 'text') ? () => { throw new Error(vanish === 'other' ? 'Unrelated failure' : `Error: Error: Invalid index. (${code})`); } : value;
  const collection = (elements, path, failAt) => {
    // Evaluated collections lose their anchored specifiers in JXA. Make the
    // mock reject that operation even when only one process happens to exist.
    const query = () => assert.fail(`Materialized native handles at ${path}`);
    Object.defineProperty(query, 'length', { get: () => { accesses.push({ pid, path }); return elements.length; } });
    query.at = index => {
      accesses.push({ pid, path });
      if (index === failAt) throw new Error('Error: Error: Invalid index. (-1719)');
      assert.ok(index >= 0 && index < elements.length); return elements[index];
    };
    query.byName = name => { accesses.push({ pid, path }); return elements.find(element => element.name() === name); };
    return query;
  };
  const children = (elements, path, failAt) => collection(elements, `${path}.uiElements`, failAt);
  const windows = dialogs.map(dialog => {
    const texts = dialog.texts.map((value, index) => ({ role: index === 0 ? gone('role', () => 'AXStaticText') : () => 'AXStaticText',
      value: index === 0 ? gone('text', () => value) : () => value, uiElements: children([], 'text') }));
    const buttons = dialog.buttons.map(button => {
      const actions = collection(button.actions.map(name => ({ name: () => name,
        perform: () => {
          assert.equal(name, 'AXPress');
          if (failedPresses < pressFailures) { failedPresses++; throw new Error('Error: Error: Can\'t get object. (-1728)'); }
          pressed++;
        } })), 'button.actions', vanish === 'action' ? 0 : undefined);
      return { role: () => 'AXButton', name: gone('button', () => button.name, '-1728'), enabled: () => button.enabled, actions, uiElements: children([], 'button') };
    });
    // A group forces the adapter to retain the PID anchor through descendants.
    const group = { role: () => 'AXGroup', uiElements: children([...texts, ...buttons], 'group', vanish === 'child' ? 0 : undefined) };
    return { subrole: gone('window', () => 'AXDialog'), uiElements: children([group], 'window') };
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
      preflightQuitNote: async () => { refreshed = true; }, delay: async () => {}, isTransientNativeError, noteEvidence,
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
    preflightQuitNote: async () => {}, delay: async () => {}, isTransientNativeError, noteEvidence,
    native: () => assert.fail('Rejected witness must not access native UI'),
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

// The acknowledgement loop, run in a sandbox like the tests above. `natives` is
// a script of results for successive osascript passes: a value is returned, an
// Error is thrown. The last entry repeats.
const owned = { pid, exe: '/owned/Ariadne', birth: 'owned birth' }, nonce = 'owned Quit';
function acknowledger({ natives, alive = () => true, delay = async () => {}, ...extra }) {
  const passes = [];
  const next = (mode) => {
    const step = natives[Math.min(passes.length, natives.length - 1)];
    passes.push(mode);
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(mode) : step;
  };
  const acknowledge = runInNewContext(`(${acknowledgeQuitNote.toString()})`, {
    join, readFile: async path => JSON.stringify(path.endsWith('launcher.json') ? { pid: 10 } : { pid, nonce }),
    identity: () => owned, observeOwned: async () => owned, alive,
    preflightQuitNote: async () => {}, delay, isTransientNativeError, noteEvidence,
    native: (mode, target) => { assert.equal(target, pid); return next(mode); },
    ...extra,
  });
  return { run: signal => acknowledge('/owned', owned.exe, nonce, owned, signal), passes };
}
const vanished = () => new Error('Command failed: osascript\nexecution error: Error: Error: Invalid index. (-1719)');
const receipt = { pid, message, informative, button: 'OK', action: 'AXPress', pressed: true };

test('Quit note error classification: vanished elements, AE timeouts and osascript timeouts are retried; everything else is fatal', () => {
  const stderr = text => Object.assign(new Error('Command failed: osascript'), { stderr: text });
  for (const error of [vanished(), new Error("Can't get object. (-1728)"), stderr('execution error: Invalid index. (-1719)'),
    stderr('execution error: AppleEvent timed out. (-1712)'), Object.assign(new Error('spawnSync /usr/bin/osascript ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' })])
    assert.equal(isTransientNativeError(error), true, error.message);
  for (const error of [new Error('Unexpected native Quit note text'), new Error('Quit note belongs to another PID'),
    new Error('System Events automation permission is unavailable (-1743); no prompt was requested'), stderr('execution error: Not authorized. (-1743)'),
    Object.assign(new Error('spawn /usr/bin/osascript ENOENT'), { code: 'ENOENT' }), new Error('Owned native process is unavailable'), undefined])
    assert.equal(isTransientNativeError(error), false, String(error?.message));
  assert.equal(isVanishedElement(new Error('Invalid index. (-1719)')), true);
  assert.equal(isVanishedElement(new Error('AppleEvent timed out. (-1712)')), false);
});

test('an element or attribute that vanishes mid-walk gives an incomplete observation, never a note check or a press', () => {
  for (const vanish of ['text', 'role', 'button', 'action', 'child', 'window']) {
    for (const mode of ['inspect', 'press']) {
      const native = nativeFixture({ vanish });
      assert.deepEqual(native.run(mode), { complete: false }, `${vanish} during ${mode}`);
      assert.equal(native.effects().pressed, 0, `${vanish} must not press`);
    }
  }
  // The other half of the dialog being unreadable must not surface as a text or button failure.
  assert.equal(nativeFixture().run('press').pressed, true);
  // Only the two vanished-element codes are skipped; any other error still escapes the walk.
  assert.throws(() => nativeFixture({ vanish: 'other' }).run('inspect'), /Unrelated failure/);
});

test('an incomplete observation or a transient osascript error is retried until the note is seen, then pressed', async () => {
  const half = nativeFixture({ vanish: 'text' }), whole = nativeFixture();
  const timeout = Object.assign(new Error('spawnSync /usr/bin/osascript ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const { run, passes } = acknowledger({ natives: [() => half.run('inspect'), vanished(), timeout, null, mode => whole.run(mode)] });
  assert.equal((await run()).pressed, true);
  assert.deepEqual(passes, ['inspect', 'inspect', 'inspect', 'inspect', 'inspect', 'press']);
  assert.equal(half.effects().pressed, 0); assert.equal(whole.effects().pressed, 1);
});

test('a transient error on press goes back to the loop: inspect again, then press again', async () => {
  const native = nativeFixture({ pressFailures: 2 });
  const { run, passes } = acknowledger({ natives: [mode => {
    try { return native.run(mode); } catch (error) { error.message += ' (-1728)'; throw error; }
  }] });
  const result = await run();
  assert.equal(result.pressed, true);
  assert.deepEqual(passes, ['inspect', 'press', 'inspect', 'press', 'inspect', 'press']);
  assert.equal(native.effects().pressed, 1);
  // An incomplete walk during the press pass takes the same road.
  const sentinel = acknowledger({ natives: [mode => mode === 'press' && !sentinel.passes.some((m, i) => i > 1 && m === 'press') ? { complete: false } : receipt] });
  assert.equal((await sentinel.run()).pressed, true);
});

test('a fatal error on inspect or press escapes the retry loop at once', async () => {
  const fatal = new Error('Unexpected native Quit note text');
  const onInspect = acknowledger({ natives: [fatal] });
  await assert.rejects(onInspect.run(), /Unexpected native Quit note text/);
  assert.deepEqual(onInspect.passes, ['inspect']);
  const onPress = acknowledger({ natives: [receipt, fatal] });
  await assert.rejects(onPress.run(), /Unexpected native Quit note text/);
  assert.deepEqual(onPress.passes, ['inspect', 'press']);
  const dismissed = acknowledger({ natives: [receipt, null] });
  await assert.rejects(dismissed.run(), /Native Quit note was not acknowledged: null/);
});

test('the note wait has no deadline: a clock far past the old 15 s still gets the note', async () => {
  let clock = 1_000_000;
  const fakeDate = { now: () => (clock += 60_000) };
  const { run, passes } = acknowledger({ natives: [{ complete: false }, null, vanished(), { complete: false }, receipt], Date: fakeDate });
  assert.equal((await run()).pressed, true);
  assert.ok(passes.length > 3 && clock > 1_000_000 + 15_000);
  // A reviewer can also see it in the source: no wall-clock bound on the wait.
  const code = acknowledgeQuitNote.toString().replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /15000|deadline/i);
  assert.doesNotMatch(code, /while \(Date\.now\(\) </);
});

test('an aborted note wait reports passes, longest inspect, request-to-last-pass time and whether the app lived', async () => {
  const controller = new globalThis.AbortController();
  let waits = 0;
  const { run } = acknowledger({ natives: [{ complete: false }],
    delay: async () => { if (++waits === 3) controller.abort(new Error('WDIO exited before startup observation')); } });
  await assert.rejects(run(controller.signal), error => {
    assert.match(error.message, /^WDIO exited before startup observation \(inspect passes: 3; longest inspect: \d+ ms; quit request to last inspect: \d+ ms; app alive: true\)$/);
    assert.equal(error.cause.message, 'WDIO exited before startup observation');
    return true;
  });
});

test('an app that exits without showing the note fails at once with the same evidence', async () => {
  let checks = 0;
  const { run } = acknowledger({ natives: [null], alive: () => ++checks <= 2 });
  await assert.rejects(run(), error => {
    assert.match(error.message, /^Owned app exited without the expected native Quit note \(inspect passes: 2; longest inspect: \d+ ms; quit request to last inspect: \d+ ms; app alive: false\)$/);
    return true;
  });
});

test('an app that exits after a press that failed transiently says the press outcome is unknown', async () => {
  let checks = 0;
  const { run, passes } = acknowledger({ natives: [receipt, vanished()], alive: () => ++checks <= 1 });
  await assert.rejects(run(), error => {
    assert.match(error.message, /^Owned app exited after a Quit note press whose outcome is unknown \(inspect passes: 1; .*app alive: false\)$/);
    return true;
  });
  assert.deepEqual(passes, ['inspect', 'press']);
  // An incomplete walk during the press never pressed, so it stays the plain exit.
  let more = 0;
  const incomplete = acknowledger({ natives: [receipt, { complete: false }], alive: () => ++more <= 1 });
  await assert.rejects(incomplete.run(), /^Error: Owned app exited without the expected native Quit note/);
});

test('noteEvidence names every field', () => {
  assert.equal(noteEvidence({ passes: 7, longest: 812, sinceRequest: 9000, alive: true }),
    'inspect passes: 7; longest inspect: 812 ms; quit request to last inspect: 9000 ms; app alive: true');
});
