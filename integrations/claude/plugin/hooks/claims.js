import { bounded, claudeSessionEndEventId, clip, envelope, hash, lifecycle, prepared, reportReceipt } from './contracts.js';

// One captured claim and one serialized reporter. Core remains the sole queue authority.
export function claimLoop(helperPath, binding) {
  let active = null;
  let polling = null;
  let admissionOpen = true;
  let reporting = null;
  let observations = 0;
  let stopped = false;
  let paused = false;
  let claimId = null;
  let blocked = null;
  let capturedSubmission = null;
  let disconnected = false;
  const pending = [];
  const route = ['--binding',binding.binding_id,'--generation',binding.generation];
  function log($, message) { $.ui.log(`Ariadne paused: ${message}`); }
  async function flush($) {
    if (reporting) return reporting;
    reporting = (async () => {
      while (pending.length) {
        const record = pending[0];
        const result = await $.process.run([helperPath,'bridge','report',...route,'--json-stdin'],
          {stdin:JSON.stringify(record.event),timeoutMs:5000});
        reportReceipt(envelope(result),record.event,binding.session);
        pending.shift();
        if (record.terminal && active === record.claim) active = null;
      }
    })();
    try { await reporting; }
    finally { reporting = null; }
  }
  async function emit($, claim, kind, payload, terminal = false) {
    const event = await lifecycle(binding,claim,kind,payload,claim.turnId);
    // A single active claim produces at most accepted/start/terminal + one late
    // conflicting submission result, each diagnostic bounded to 64KiB.
    pending.push({event,claim,terminal});
    try { await flush($); }
    catch { log($,'Lifecycle evidence is pending; retain event IDs and restore the installed helper.'); }
  }
  async function uncertain($, claim, reason) {
    paused = true;
    if (claim.uncertainReasons.has(reason)) return;
    claim.uncertainReasons.add(reason);
    await emit($,claim,'uncertain',{reason});
  }
  async function settled($, claim, result) {
    if (result && typeof result.drop === 'string') {
      paused = true;
      if (claim.turnId !== null) {
        await uncertain($,claim,'Prompt submission reported a drop after matching turn evidence; reconcile in the app.');
      } else {
        await emit($,claim,'rejected',{reason:'Claude prompt submission was dropped before matching turn evidence.'},true);
      }
    } else if (result && typeof result.text === 'string'
      && result.text === claim.formatted_payload && await hash(result.text) === claim.payload_sha256) {
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
  async function runPoll($) {
    try {
      await flush($);
      if (!admissionOpen || stopped || paused || active || (capturedSubmission && !capturedSubmission.settled)) return;
      if (await $.session.id() !== binding.external_session_id) {
        paused = true;
        log($,'The original Claude session changed; reconnect explicitly after recovery.');
        return;
      }
      if (!admissionOpen || stopped) return;
      claimId ??= globalThis.crypto.randomUUID();
      const result = envelope(await $.process.run([helperPath,'bridge','claim',...route,'--request-id',claimId],{timeoutMs:5000}));
      blocked = null;
      if (result === null) { claimId = null; return; }
      const value = await prepared(result,binding);
      const captured = {...value,turnId:null,accepted:false,settled:false,terminalSnapshots:[],terminalGap:false,uncertainReasons:new Set()};
      active = captured;
      capturedSubmission = captured;
      claimId = null;
      const currentSession = await $.session.id();
      if (!admissionOpen || stopped || currentSession !== binding.external_session_id) {
        captured.settled = true;
        await uncertain($,captured,'Claim admission closed or the original Claude session changed after a durable claim; retain the original attempt for recovery.');
        return;
      }
      // Do not await: the SDK promise can settle before or after turn.start.
      // All callbacks close over this original binding and captured attempt.
      try {
        void $.prompt.submit({text:captured.formatted_payload})
          .then(result => settled($,captured,result))
          .catch(() => uncertain($,captured,'Prompt submission failed with unknown delivery; reconcile the original attempt.'))
          .finally(() => { captured.settled = true; });
      } catch {
        await uncertain($,captured,'Prompt submission threw with unknown delivery; reconcile the original attempt.');
        captured.settled = true;
      }
    } catch (error) {
      if (error?.code === 'invalid_transition') {
        const reason = typeof error.details?.reason === 'string' ? error.details.reason : 'blocked';
        if (blocked !== reason) {
          blocked = reason;
          log($,`Dispatch is withheld by the app (${reason}); claims resume when the owner resumes or recovers.`);
        }
        return;
      }
      log($,'Claim/report helper failed. The same claim request/event IDs are retained; no prompt was resent.');
    }
  }
  function observe(action) {
    observations += 1;
    return action().finally(() => { observations -= 1; });
  }
  function start($, event) { return observe(() => observeStart($,event)); }
  function complete($, event) { return observe(() => observeComplete($,event)); }
  async function observeStart($, event) {
    const captured = active;
    if (!captured || captured.turnId !== null || !bounded(event.turnId)
      || typeof event.text !== 'string'
      || !event.text.startsWith(`${captured.wire_marker}\n`)
      || event.text !== captured.formatted_payload
      || await hash(event.text) !== captured.payload_sha256) return;
    if (await $.session.id() !== binding.external_session_id) {
      await uncertain($,captured,'Session identity changed before matching turn.start; recover the original attempt.');
      return;
    }
    captured.turnId = event.turnId;
    captured.startReporting = (async () => {
      if (!captured.accepted) {
        captured.accepted = true;
        await emit($,captured,'accepted',{receipt:null});
      }
      await emit($,captured,'turn_started',{});
    })();
    await captured.startReporting;
  }
  async function observeComplete($, event) {
    const captured = active ?? capturedSubmission;
    if (!captured || event.agentId !== undefined || !captured.turnId || captured.turnId !== event.turnId) return;
    await captured.startReporting;
    const status = event.isAborted || event.reason === 'aborted' ? 'interrupted'
      : event.reason === 'answer' ? 'completed' : 'failed';
    if (!['answer','aborted','refusal','error'].includes(event.reason) || typeof event.isAborted !== 'boolean' || typeof event.answer !== 'string') {
      await uncertain($,captured,'Unsupported Claude terminal evidence; recover the original attempt.');
      return;
    }
    paused ||= status !== 'completed';
    const diagnostic = clip(event.answer);
    const payload = {status,reason:event.reason,
      diagnostic_text:diagnostic.text || null,truncated:diagnostic.truncated};
    const snapshot = JSON.stringify(payload);
    if (captured.terminalSnapshots.includes(snapshot)) return;
    if (captured.terminalSnapshots.length === 2) {
      paused = true;
      if (!captured.terminalGap) {
        captured.terminalGap = true;
        await uncertain($,captured,'Unsupported repeated contradictory Claude terminal revisions; retained original and first conflict, additional raw callbacks were not persisted. Reconcile in the app.');
        log($,'Unsupported contradictory terminal revisions exceeded retained evidence; new claims are stopped.');
      }
      return;
    }
    if (captured.terminalSnapshots.length) paused = true;
    captured.terminalSnapshots.push(snapshot);
    await emit($,captured,'turn_finished',payload,true);
  }
  async function stop($, sessionEnd = false) {
    stopped = true;
    await quiesce();
    if (sessionEnd && !disconnected) {
      disconnected = true;
      pending.push({event:{event_id:claudeSessionEndEventId(binding.binding_id,binding.generation),binding_id:binding.binding_id,generation:binding.generation,
        input_id:null,attempt_id:null,host_turn_id:null,observed_at:new Date().toISOString(),kind:'disconnected',payload:{reason:'Original Claude session ended.'}},terminal:false});
    }
    try { await flush($); }
    catch { log($,'Lifecycle evidence remains unpersisted at session end; recover it in the app.'); }
  }
  return {poll,start,complete,stop,quiesce,
    outstanding:() => polling !== null || observations > 0 || active !== null || pending.length > 0 || claimId !== null || (capturedSubmission !== null && !capturedSubmission.settled),
    status:() => ({active:active ? {input_id:active.input_id,attempt_id:active.attempt_id,host_turn_id:active.turnId} : null,
      pending_reports:pending.length,pending_claim_request_id:claimId,admission_open:admissionOpen,paused,stopped,unsupported_terminal_revisions:capturedSubmission?.terminalGap ?? false})};
}
