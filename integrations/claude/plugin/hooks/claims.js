import { bounded, claudeSessionEndEventId, clip, envelope, hash, lifecycle, prepared, reportReceipt } from './contracts.js';

// 'exact' when text is the payload, 'framed' when the payload sits intact as whole
// lines inside host framing text, otherwise null.
function carried(text, captured) {
  const payload = captured.formatted_payload;
  if (text === payload) return 'exact';
  for (let at = text.indexOf(captured.wire_marker); at !== -1; at = text.indexOf(captured.wire_marker, at + 1)) {
    if ((at !== 0 && text[at - 1] !== '\n') || !text.startsWith(payload, at)) continue;
    const end = at + payload.length;
    if (end === text.length || text[end] === '\n') return 'framed';
  }
  return null;
}

// Owner-facing notices. Each prints once when its state starts, never every poll.
export const NOTICES = Object.freeze({
  removed:'This session was removed from Ariadne (or connected elsewhere). Run /ariadne-connect to connect again.',
  owner_paused:'Ariadne: sending to this session is paused in the app. Messages will arrive here when you resume it.',
  session_closed:'Ariadne: this session is closed in the app. Messages will arrive here if you reopen it.',
  recovery_required:'Ariadne: a message to this session needs your attention in the app before more can be sent.',
  blocked:'Ariadne: the app is holding messages for this session for now. They will arrive here when it lets them through.',
  failure:'Ariadne: could not check the app for new messages. It will keep trying.',
  reports:"Ariadne: could not save Claude's progress to the app yet. It will keep trying.",
  ended:'Ariadne: could not tell the app that this conversation ended. Open the Ariadne app to see its current state.',
});
// What still holds a loop open, in the words /ariadne-connect and /ariadne-disconnect use.
export const BUSY = Object.freeze({
  answering:'Claude is still answering a message from Ariadne. Run the command again after it finishes.',
  reports:"Ariadne could not save Claude's last progress to the app yet. Make sure the Ariadne app is open, then run the command again.",
  claim:'Ariadne could not confirm a message it was fetching from the app. Make sure the Ariadne app is open, then run the command again.',
});
// The binding no longer exists or another connection replaced it: polling cannot recover.
export function bindingGone(error) {
  return error?.code === 'stale_generation' || error?.details?.reason === 'session_removed';
}
const SEEN_TURNS = 64;
// How long a turn that may have taken a mid-turn message in waits for a next
// turn that carries the message instead (Claude runs it as its own turn then).
export const FOLD_GRACE_MS = 5000;
// Distinct terminal callbacks kept for a turn whose fold is not yet confirmed.
const FOLD_SNAPSHOTS = 3;

// One captured claim and one serialized reporter. Core remains the sole queue authority.
export function claimLoop(helperPath, binding, {onEnded = () => {}, now = () => Date.now()} = {}) {
  let active = null;
  let polling = null;
  let admissionOpen = true;
  let reporting = null;
  let observations = 0;
  let stopped = false;
  let ended = false;
  let claimId = null;
  // An earlier try with claimId had an unknown outcome, so the app may have saved it.
  let claimUnknown = false;
  let claimNotice = null;
  let reportNotice = false;
  let capturedSubmission = null;
  let disconnected = false;
  let observedForm = false;
  const pending = [];
  // Main-thread turns that are running now, and every turn whose start was seen.
  const running = new Set();
  const seen = [];
  const route = ['--binding',binding.binding_id,'--generation',binding.generation];
  function claimSays($, key) {
    if (claimNotice === key) return;
    claimNotice = key;
    $.ui.log(NOTICES[key]);
  }
  function end($) {
    // A loop already stopped (this conversation ended or was replaced) expects
    // its binding to be gone; only a live loop tells the owner.
    const live = !stopped;
    stopped = true;
    admissionOpen = false;
    // Evidence for a binding that no longer exists has nowhere to go.
    pending.length = 0;
    if (ended) return;
    ended = true;
    if (!live) return;
    $.ui.log(NOTICES.removed);
    onEnded($);
  }
  async function flush($) {
    if (reporting) return reporting;
    reporting = (async () => {
      while (pending.length) {
        const record = pending[0];
        try {
          const result = await $.process.run([helperPath,'bridge','report',...route,'--json-stdin'],
            {stdin:JSON.stringify(record.event),timeoutMs:5000});
          reportReceipt(envelope(result),record.event,binding.session);
        } catch (error) {
          if (bindingGone(error)) { end($); return; }
          throw error;
        }
        pending.shift();
        // A durable terminal or uncertain record hands the attempt to the app.
        if (record.release && active === record.claim) active = null;
      }
    })();
    try {
      await reporting;
      reportNotice = false;
    } catch (error) {
      if (!reportNotice && !stopped) { reportNotice = true; $.ui.log(NOTICES.reports); }
      throw error;
    } finally { reporting = null; }
  }
  async function emit($, claim, kind, payload, release = false) {
    const event = await lifecycle(binding,claim,kind,payload,claim.turnId);
    // A single active claim produces at most accepted/start/terminal + one late
    // conflicting submission result, each diagnostic bounded to 64KiB.
    if (release) claim.released = true;
    pending.push({event,claim,release});
    // A failed save is retried with the same event on the next poll.
    try { await flush($); }
    catch { /* notice printed by flush */ }
  }
  async function uncertain($, claim, reason) {
    if (claim.uncertainReasons.has(reason)) return;
    claim.uncertainReasons.add(reason);
    await emit($,claim,'uncertain',{reason},true);
  }
  async function settled($, claim, result) {
    // The app already holds an unstarted attempt as rejected or uncertain.
    if (claim.released && claim.turnId === null) return;
    if (result && typeof result.drop === 'string') {
      if (claim.turnId !== null) {
        await uncertain($,claim,'Prompt submission reported a drop after matching turn evidence; reconcile in the app.');
      } else {
        await emit($,claim,'rejected',{reason:'Claude prompt submission was dropped before matching turn evidence.'},true);
      }
    } else if (result && typeof result.text === 'string'
      && result.text === claim.formatted_payload && await hash(result.text) === claim.payload_sha256) {
      // Claude may fold a prompt submitted mid-turn into the running turn, so no
      // turn.start carries it; that running turn's end is then its terminal,
      // unless the next turn carries the prompt (see observeComplete).
      claim.foldable = new Set(running);
      if (!claim.accepted) {
        claim.accepted = true;
        await emit($,claim,'accepted',{receipt:null});
      }
    } else {
      await uncertain($,claim,'Prompt submission returned altered or unsupported evidence; do not resend automatically.');
    }
  }
  function poll($) {
    if (polling) return Promise.resolve();
    if (stopped) return Promise.resolve();
    polling = Promise.resolve().then(() => runPoll($)).finally(() => { polling = null; });
    return polling;
  }
  async function quiesce() {
    admissionOpen = false;
    if (polling) await polling;
  }
  function refused($, error) {
    const reason = error?.details?.reason;
    if (bindingGone(error)) { end($); return; }
    // The app is closed or does not hold this session right now; retry quietly.
    // The lease is checked before the store, so an ID an earlier unanswered try
    // may have saved is kept; otherwise nothing was saved under it.
    if (reason === 'lease_invalid') {
      if (!claimUnknown) claimId = null;
      return;
    }
    if (error?.code === 'invalid_transition') {
      // Core replays a saved claim before it checks pause, close or recovery,
      // so this refusal proves nothing was saved under the ID.
      claimId = null;
      claimUnknown = false;
      claimSays($,['owner_paused','session_closed','recovery_required'].includes(reason) ? reason : 'blocked');
      return;
    }
    claimUnknown = true;
    claimSays($,'failure');
  }
  async function runPoll($) {
    // Saved evidence goes first; a claim never overtakes an unsaved report.
    try { await flush($); }
    catch { return; }
    if (active?.folding && !stopped && now() >= active.folding.until) await confirmFold($,active);
    if (!admissionOpen || stopped || active || (capturedSubmission && !capturedSubmission.settled)) return;
    // Another conversation is current; the register follows it and retires this loop.
    if (await $.session.id() !== binding.external_session_id) return;
    if (!admissionOpen || stopped) return;
    // A timed-out or failed claim is retried with its original request ID.
    claimId ??= globalThis.crypto.randomUUID();
    let value;
    try {
      const result = envelope(await $.process.run([helperPath,'bridge','claim',...route,'--request-id',claimId],{timeoutMs:5000}));
      if (result === null) { claimNotice = null; claimId = null; claimUnknown = false; return; }
      value = await prepared(result,binding);
    } catch (error) { refused($,error); return; }
    claimNotice = null;
    const captured = {...value,turnId:null,accepted:false,settled:false,released:false,foldable:new Set(),folding:null,terminalSnapshots:[],terminalGap:false,uncertainReasons:new Set()};
    active = captured;
    capturedSubmission = captured;
    claimId = null;
    claimUnknown = false;
    // A claim saved while a connect/disconnect waits is still delivered: the
    // binding is unchanged until that command runs, and it waits for the turn.
    if (stopped || await $.session.id() !== binding.external_session_id) {
      captured.settled = true;
      await uncertain($,captured,'The Claude session ended or changed after a durable claim; retain the original attempt for recovery.');
      return;
    }
    // Do not await: the SDK promise can settle before or after turn.start.
    // All callbacks close over this original binding and captured attempt.
    try {
      void $.prompt.submit({text:captured.formatted_payload,asUser:true})
        .then(result => settled($,captured,result))
        .catch(() => uncertain($,captured,'Prompt submission failed with unknown delivery; reconcile the original attempt.'))
        .finally(() => { captured.settled = true; });
    } catch {
      await uncertain($,captured,'Prompt submission threw with unknown delivery; reconcile the original attempt.');
      captured.settled = true;
    }
  }
  function observe(action) {
    observations += 1;
    return action().finally(() => { observations -= 1; });
  }
  function start($, event) { return observe(() => observeStart($,event)); }
  function complete($, event) { return observe(() => observeComplete($,event)); }
  async function observeStart($, event) {
    // A stopped loop no longer sees turns: a later start must not fold or report anything.
    if (stopped || event.agentId !== undefined) return;
    if (bounded(event.turnId)) {
      running.add(event.turnId);
      seen.push(event.turnId);
      if (seen.length > SEEN_TURNS) seen.shift();
    }
    const captured = active;
    // The payload digest was verified by prepared() at claim time; the host may
    // frame the text, so a whole-text digest is not meaningful here.
    if (!captured || captured.turnId !== null || !bounded(event.turnId)) return;
    const form = typeof event.text === 'string' ? carried(event.text,captured) : null;
    if (form === null) {
      // The next turn does not carry the message, so Claude took it into the
      // turn that just ended.
      if (captured.folding) await confirmFold($,captured);
      return;
    }
    // Claude runs the message as its own turn: the earlier turn did not answer it.
    captured.folding = null;
    if (await $.session.id() !== binding.external_session_id) {
      await uncertain($,captured,'Session identity changed before matching turn.start; recover the original attempt.');
      return;
    }
    captured.turnId = event.turnId;
    if (!observedForm) {
      observedForm = true;
      $.ui.log(`Ariadne: turn.start carried the ${form} payload (${event.text.length} chars).`);
    }
    captured.startReporting = (async () => {
      if (!captured.accepted) {
        captured.accepted = true;
        await emit($,captured,'accepted',{receipt:null});
      }
      await emit($,captured,'turn_started',{});
    })();
    await captured.startReporting;
  }
  // The submission was accepted, no turn.start carried it, and this turn was
  // running when it was accepted (or started before this loop saw any start).
  // A stopped loop no longer sees starts, so it never folds.
  function folded(captured, event) {
    return !stopped && captured === active && !captured.released
      && captured.turnId === null && captured.accepted && bounded(event.turnId)
      && (captured.foldable.has(event.turnId) || !seen.includes(event.turnId));
  }
  // Claude ran the message inside the turn that ended: that turn is its turn.
  async function confirmFold($, captured) {
    const {turnId,events} = captured.folding;
    captured.folding = null;
    captured.turnId = turnId;
    captured.startReporting = emit($,captured,'turn_started',{});
    for (const event of events) await finish($,captured,event);
  }
  function terminalKey(event) {
    return JSON.stringify([event.reason,event.isAborted,event.answer]);
  }
  async function observeComplete($, event) {
    if (event.agentId !== undefined) return;
    running.delete(event.turnId);
    const captured = active ?? capturedSubmission;
    if (!captured) return;
    // A stopped loop still finishes a message whose turn it saw start, but a message with no matched turn never folds into one.
    if (stopped && captured.turnId === null) return;
    // Whether this turn answered the message is known only once the next turn
    // starts without it, or none starts within the grace period.
    if (captured.folding?.turnId === event.turnId) {
      const {events} = captured.folding;
      if (events.length < FOLD_SNAPSHOTS && !events.some(kept => terminalKey(kept) === terminalKey(event))) events.push(event);
      return;
    }
    if (folded(captured,event)) {
      captured.folding = {turnId:event.turnId,until:now() + FOLD_GRACE_MS,events:[event]};
      return;
    }
    if (!captured.turnId || captured.turnId !== event.turnId) return;
    await finish($,captured,event);
  }
  async function finish($, captured, event) {
    await captured.startReporting;
    const status = event.isAborted || event.reason === 'aborted' ? 'interrupted'
      : event.reason === 'answer' ? 'completed' : 'failed';
    if (!['answer','aborted','refusal','error'].includes(event.reason) || typeof event.isAborted !== 'boolean' || typeof event.answer !== 'string') {
      await uncertain($,captured,'Unsupported Claude terminal evidence; recover the original attempt.');
      return;
    }
    const diagnostic = clip(event.answer);
    const payload = {status,reason:event.reason,
      diagnostic_text:diagnostic.text || null,truncated:diagnostic.truncated};
    const snapshot = JSON.stringify(payload);
    if (captured.terminalSnapshots.includes(snapshot)) return;
    if (captured.terminalSnapshots.length === 2) {
      if (!captured.terminalGap) {
        captured.terminalGap = true;
        await uncertain($,captured,'Unsupported repeated contradictory Claude terminal revisions; retained original and first conflict, additional raw callbacks were not persisted. Reconcile in the app.');
      }
      return;
    }
    captured.terminalSnapshots.push(snapshot);
    await emit($,captured,'turn_finished',payload,true);
  }
  async function stop($, sessionEnd = false) {
    stopped = true;
    await quiesce();
    const captured = active;
    if (captured && captured.turnId === null && !captured.released && !ended) {
      // A pending fold is confirmed only on evidence that the turn it was folded
      // into processed the message: that turn's end was seen after acceptance
      // (that is what a pending fold is) and the grace period ran out with no later
      // turn carrying the message. Inside the grace period the message may still
      // have been queued to run as its own turn, which a stopped conversation
      // never runs, so it is not confirmed.
      if (captured.folding && now() >= captured.folding.until) await confirmFold($,captured);
      // Otherwise the message can no longer be matched to a turn in this
      // conversation: the owner decides whether to check or send it again.
      else await uncertain($,captured,'The Claude conversation ended or changed before the message was seen starting a turn; ask the owner whether to send it again.');
    }
    // A fold still inside its grace period is dropped: nothing later may confirm it.
    if (captured) captured.folding = null;
    if (sessionEnd && !disconnected && !ended) {
      disconnected = true;
      pending.push({event:{event_id:claudeSessionEndEventId(binding.binding_id,binding.generation),binding_id:binding.binding_id,generation:binding.generation,
        input_id:null,attempt_id:null,host_turn_id:null,observed_at:new Date().toISOString(),kind:'disconnected',payload:{reason:'Original Claude session ended.'}},release:false});
    }
    try { await flush($); }
    catch { if (sessionEnd) $.ui.log(NOTICES.ended); }
  }
  // Before an owner connect/disconnect: hold new claims, finish what is in
  // flight, save pending reports and retry an unconfirmed claim with its ID.
  async function settle($) {
    await quiesce();
    if (stopped) {
      try { await flush($); } catch { /* retried later */ }
      return;
    }
    admissionOpen = claimId !== null;
    try { await poll($); }
    finally { admissionOpen = false; }
  }
  // Retry unsaved reports of a retired loop; true once nothing is left.
  async function drain($) {
    try { await flush($); } catch { /* retried later */ }
    return pending.length === 0;
  }
  function busy() {
    if (ended) return null;
    if (active || observations > 0 || (capturedSubmission && !capturedSubmission.settled)) return 'answering';
    if (pending.length) return 'reports';
    if (claimId !== null) return 'claim';
    return null;
  }
  return {poll,start,complete,stop,quiesce,settle,drain,busy,
    reopen:() => { if (!stopped) admissionOpen = true; },
    outstanding:() => polling !== null || observations > 0 || active !== null || pending.length > 0 || claimId !== null || (capturedSubmission !== null && !capturedSubmission.settled),
    status:() => ({active:active ? {input_id:active.input_id,attempt_id:active.attempt_id,host_turn_id:active.turnId} : null,
      pending_reports:pending.length,pending_claim_request_id:claimId,admission_open:admissionOpen,stopped,ended,unsupported_terminal_revisions:capturedSubmission?.terminalGap ?? false})};
}
