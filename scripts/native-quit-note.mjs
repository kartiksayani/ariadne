import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { alive, delay, identity, observeOwned } from './run-native-e2e.mjs';

// Assertions are deliberately literal product expectations, not a product-only
// acknowledgement hook. The action below targets the actual AppKit AX button.
export function selectQuitNote(observation, pid) {
  if (observation.pid !== pid) throw new Error('Quit note belongs to another PID');
  if (!observation.dialogs.length) return null;
  if (observation.dialogs.length !== 1) throw new Error('Expected one owned Quit note dialog');
  const dialog = observation.dialogs[0];
  const message = 'Host work already sent can continue after Ariadne quits.';
  const informative = 'Queued, unsent inputs wait until you reopen Ariadne.';
  if (dialog.texts.length !== 2 || !dialog.texts.includes(message) || !dialog.texts.includes(informative)) throw new Error('Unexpected native Quit note text');
  if (dialog.buttons.length !== 1) throw new Error('Quit note must have exactly one button');
  const button = dialog.buttons[0];
  if (button.name !== 'OK' || button.enabled !== true || !button.actions.includes('AXPress')) throw new Error('Quit note OK is unavailable');
  return { pid, message, informative, button: button.name, action: 'AXPress' };
}

// An AX element that disappears between listing it and reading it raises
// errAEIllegalIndex (-1719) or errAENoSuchObject (-1728). The tree is live, so
// that is "not settled yet", never a product failure. This also runs inside the
// JXA script (embedded through toString), so it must stay self-contained.
export function isVanishedElement(error) {
  return /\((-1719|-1728)\)/.test(String(error && error.message || error));
}

// Errors from one osascript pass that mean "observe again": a vanished element,
// an Apple event timeout (-1712), or osascript outliving its execFileSync
// timeout. Every other error (permissions, wrong text, wrong PID) is fatal.
export function isTransientNativeError(error) {
  if (!error) return false;
  if (error.code === 'ETIMEDOUT') return true;
  const text = String(error.stderr || '') + String(error.message || '');
  return isVanishedElement(text) || /\(-1712\)/.test(text);
}

// What a reviewer needs when the wait ends without a note, so a failure shows
// whether the observer was slow, starved or never saw a dialog.
export function noteEvidence({ passes, longest, sinceRequest, alive }) {
  return `inspect passes: ${passes}; longest inspect: ${longest} ms; quit request to last inspect: ${sinceRequest} ms; app alive: ${alive}`;
}

// Hosted macOS26 image grants osascript Accessibility and System Events Apple
// events. Probe both without asking for consent; never change TCC/settings.
// https://github.com/actions/runner-images/blob/6df43a84a99f76801fac238d7b7ddb2bd5808251/images/macos/scripts/build/configure-tccdb-macos.sh
// Apple SDK: AXIsProcessTrustedWithOptions(NULL),
// AEDeterminePermissionToAutomateTarget(..., askUserIfNeeded=false).
export const quitNoteScript = `
${selectQuitNote.toString()}
${isVanishedElement.toString()}
function run(args) {
  ObjC.import('AppKit');
  ObjC.import('ApplicationServices');
  ObjC.import('CoreServices');
  ObjC.bindFunction('AEDeterminePermissionToAutomateTarget', ['int', ['void *', 'unsigned int', 'unsigned int', 'bool']]);
  if (!$.AXIsProcessTrustedWithOptions(null)) throw new Error('osascript Accessibility permission is unavailable; no prompt was requested');
  const services = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.systemevents');
  // JXA bridges NSUInteger (unsigned long) as a string; "0" is truthy.
  if (Number(services.count) === 0) {
    if (args[0] === 'preflight') return JSON.stringify({ serviceRunning: false });
    throw new Error('System Events is unavailable during native Quit acknowledgement');
  }
  const address = $.NSAppleEventDescriptor.descriptorWithProcessIdentifier(services.objectAtIndex(0).processIdentifier);
  const permission = $.AEDeterminePermissionToAutomateTarget(address.aeDesc, 0x2a2a2a2a, 0x2a2a2a2a, false);
  if (permission !== 0) throw new Error('System Events automation permission is unavailable (' + permission + '); no prompt was requested');
  if (args[0] === 'preflight') return JSON.stringify({ serviceRunning: true, accessibility: true, automation: true });
  const pid = Number(args[1]);
  // Never evaluate an element collection: JXA materializes name-based handles,
  // which can resolve to another Ariadne process. Keep the unixId predicate in
  // every descendant specifier and read only scalar attributes.
  const processes = Application('System Events').applicationProcesses.whose({ unixId: pid });
  if (processes.length !== 1) throw new Error('Owned native process is unavailable');
  const process = processes.at(0);
  if (process.unixId() !== pid) throw new Error('Owned native process is unavailable');
  // The tree is live: skip what vanishes mid-walk and report the observation as
  // incomplete, so a half-read dialog never reaches the text and button checks.
  let complete = true;
  const read = (get, fallback) => {
    try { return get(); }
    catch (error) { if (!isVanishedElement(error)) throw error; complete = false; return fallback; }
  };
  function descendants(parent, elements) {
    const children = parent.uiElements;
    const count = read(() => children.length, 0);
    for (let index = 0; index < count; index++) {
      const child = read(() => children.at(index), null);
      if (!child) continue;
      elements.push(child);
      descendants(child, elements);
    }
    return elements;
  }
  const dialogs = [], buttons = [];
  const windows = process.windows;
  const windowCount = read(() => windows.length, 0);
  for (let index = 0; index < windowCount; index++) {
    const window = read(() => windows.at(index), null);
    if (!window || read(() => window.subrole(), null) !== 'AXDialog') continue;
    const texts = [], infos = [], targets = [];
    for (const element of descendants(window, [])) {
      const role = read(() => element.role(), null);
      if (role === 'AXStaticText') {
        const value = read(() => element.value(), undefined);
        if (value !== undefined) texts.push(value);
      } else if (role === 'AXButton') {
        const info = read(() => {
          const actions = [];
          for (let index = 0; index < element.actions.length; index++) actions.push(element.actions.at(index).name());
          return { name: element.name(), enabled: element.enabled(), actions };
        }, null);
        if (info) { infos.push(info); targets.push(element); }
      }
    }
    dialogs.push({ texts, buttons: infos });
    buttons.push(targets);
  }
  if (!complete) return JSON.stringify({ complete: false });
  const note = selectQuitNote({ pid, dialogs }, pid);
  if (note && args[0] === 'press') buttons[0][0].actions.byName('AXPress').perform();
  return JSON.stringify(note ? { ...note, pressed: args[0] === 'press' } : null);
}`;

function native(mode, pid) {
  return JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', quitNoteScript, mode, String(pid ?? '')], { encoding: 'utf8', timeout: 5000 }));
}

export async function preflightQuitNote() {
  let permissions = native('preflight');
  if (!permissions.serviceRunning) {
    // Ordinary built-in service launch only; neither an Apple event nor a grant.
    execFileSync('/usr/bin/open', ['-g', '-b', 'com.apple.systemevents'], { timeout: 5000 });
    const end = Date.now() + 5000;
    do { await delay(50); permissions = native('preflight'); }
    while (!permissions.serviceRunning && Date.now() < end);
  }
  if (!permissions.serviceRunning || !permissions.accessibility || !permissions.automation) throw new Error('Native Quit acknowledgement prerequisite unavailable');
  return permissions;
}

export async function acknowledgeQuitNote(root, binary, nonce, owned, signal) {
  const launcher = JSON.parse(await readFile(join(root, 'launcher.json'), 'utf8'));
  const verify = async () => {
    if (signal?.aborted) throw signal.reason;
    const current = identity(owned.pid);
    if (owned.exe !== binary || current.exe !== binary || current.birth !== owned.birth) throw new Error('Refusing to acknowledge changed native process identity');
    const verified = await observeOwned(root, binary, nonce, launcher.pid, 1000, signal);
    if (verified.pid !== owned.pid || verified.birth !== owned.birth) throw new Error('Quit acknowledgement witness identity mismatch');
  };
  // Refresh the prerequisite check before the Quit request exists, so a System
  // Events relaunch never delays the first inspect after the request.
  await preflightQuitNote();
  // The unchanged demo contains delivered Running work, so this native journey
  // must observe its note. Quiet Quit must never be substituted as passing proof.
  // System Events may idle-quit during the long journey, so re-check it
  // periodically while waiting for the request.
  let refreshed = Date.now();
  for (;;) {
    if (signal?.aborted) throw signal.reason;
    try {
      const request = JSON.parse(await readFile(join(root, 'quit-request.json'), 'utf8'));
      if (request.pid !== owned.pid || request.nonce !== nonce) throw new Error('Quit acknowledgement request identity mismatch');
      break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Date.now() - refreshed >= 30000) { await preflightQuitNote(); refreshed = Date.now(); }
    await delay(25);
  }
  // Re-run the readiness check (relaunching System Events if needed) once the
  // owned Quit request exists and before the first inspect.
  await preflightQuitNote();
  await verify();
  // There is no deadline on seeing the note, by design: how long the app takes
  // to drain before it shows the alert is not what this journey asserts. The wait
  // ends on a press, on the app exiting without a note, or on `signal` (WDIO
  // exiting, or the runner's phase timeout, which is the outer hang guard).
  const requestedAt = Date.now();
  let passes = 0, longest = 0, lastPassAt = requestedAt;
  const evidence = () => noteEvidence({ passes, longest, sinceRequest: lastPassAt - requestedAt, alive: alive(owned.pid) });
  // One osascript pass. `undefined` means "not seen yet": an incomplete
  // observation or a transient Apple event error. `null` means no dialog.
  const observe = mode => {
    const started = Date.now();
    if (mode === 'inspect') passes++;
    try {
      const result = native(mode, owned.pid);
      return result && result.complete === false ? undefined : result;
    } catch (error) {
      if (!isTransientNativeError(error)) throw error;
      return undefined;
    } finally {
      if (mode === 'inspect') { lastPassAt = Date.now(); longest = Math.max(longest, lastPassAt - started); }
    }
  };
  try {
    for (;;) {
      if (!alive(owned.pid)) throw new Error('Owned app exited without the expected native Quit note (' + evidence() + ')');
      await verify();
      if (observe('inspect')) {
        await verify();
        const note = observe('press');
        // The dialog changed under the press: observe it again, then press again.
        if (note === undefined) { await delay(25); continue; }
        if (!note?.pressed || note.pid !== owned.pid) throw new Error('Native Quit note was not acknowledged: ' + JSON.stringify(note));
        return note;
      }
      await delay(25);
    }
  } catch (error) {
    if (signal?.aborted && error === signal.reason) throw new Error(String(error && error.message || error) + ' (' + evidence() + ')', { cause: error });
    throw error;
  }
}
