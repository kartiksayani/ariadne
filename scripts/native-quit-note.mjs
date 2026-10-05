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

// Hosted macOS26 image grants osascript Accessibility and System Events Apple
// events. Probe both without asking for consent; never change TCC/settings.
// https://github.com/actions/runner-images/blob/6df43a84a99f76801fac238d7b7ddb2bd5808251/images/macos/scripts/build/configure-tccdb-macos.sh
// Apple SDK: AXIsProcessTrustedWithOptions(NULL),
// AEDeterminePermissionToAutomateTarget(..., askUserIfNeeded=false).
export const quitNoteScript = `
${selectQuitNote.toString()}
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
  const processes = Application('System Events').applicationProcesses.whose({ unixId: pid })();
  if (processes.length !== 1 || processes[0].unixId() !== pid) throw new Error('Owned native process is unavailable');
  const dialogs = [], buttons = [];
  for (const window of processes[0].windows()) {
    if (window.subrole() !== 'AXDialog') continue;
    const contents = window.entireContents();
    const targets = contents.filter(element => element.role() === 'AXButton');
    dialogs.push({
      texts: contents.filter(element => element.role() === 'AXStaticText').map(element => element.value()),
      buttons: targets.map(button => ({ name: button.name(), enabled: button.enabled(), actions: button.actions().map(action => action.name()) })),
    });
    buttons.push(targets);
  }
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
  // The unchanged demo contains delivered Running work, so this native journey
  // must observe its note. Quiet Quit must never be substituted as passing proof.
  for (;;) {
    if (signal?.aborted) throw signal.reason;
    try {
      const request = JSON.parse(await readFile(join(root, 'quit-request.json'), 'utf8'));
      if (request.pid !== owned.pid || request.nonce !== nonce) throw new Error('Quit acknowledgement request identity mismatch');
      break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(25);
  }
  // Build and the App journey can outlast the initial prerequisite check.
  // Refresh it only after the owned Quit request and process witness match.
  await verify();
  await preflightQuitNote();
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (!alive(owned.pid)) throw new Error('Owned app exited without the expected native Quit note');
    await verify();
    if (native('inspect', owned.pid)) {
      await verify();
      const note = native('press', owned.pid);
      if (!note?.pressed || note.pid !== owned.pid) throw new Error('Native Quit note was not acknowledged: ' + JSON.stringify(note));
      return note;
    }
    await delay(25);
  }
  throw new Error('Native Quit note observation deadline');
}
