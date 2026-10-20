// Consumers of canonical core/agent-protocol wire records, not another queue model.
export const API_VERSION = 1;
export const HOST_VERSION = '2.1.287';
// ADR-0071: HOST_VERSION is the qualified baseline and the minimum required version; any newer well-formed version is accepted as untested.
export function hostVersionStatus(version, baseline = HOST_VERSION) {
  const parse = text => {
    const parts = typeof text === 'string' ? text.split('.') : [];
    return parts.length === 3 && parts.every(part => /^(0|[1-9][0-9]{0,8})$/.test(part)) ? parts.map(Number) : null;
  };
  const base = parse(baseline), seen = parse(version);
  if (!base || !seen) return null;
  for (let i = 0; i < 3; i += 1) {
    if (seen[i] !== base[i]) return seen[i] > base[i] ? 'untested' : null;
  }
  return 'qualified';
}
export function claudeSessionEndEventId(bindingId, generation) {
  if (!uuid(bindingId) || !uuid(generation)) throw new ModError('Invalid saved Claude session-end scope.');
  return `claude:session-ended:${bindingId}:${generation}`;
}
// `message` is for tests and diagnostics; `plain`, when set, is the owner-facing sentence.
export class ModError extends Error {
  constructor(message, plain) {
    super(message);
    if (plain !== undefined) this.plain = plain;
  }
}
// Allow the helper's five-second control timeout to return a typed refusal.
export const HELPER_TIMEOUT_MS = 8000;
export const NOTICE_GRACE_MS = 120000;
const TRANSIENT = new Set(['store_busy','timeout','io_error','process_rejected','host_unreachable']);
// Spawn failures with these fixed OS codes require repairing the installation.
// Other rejected SDK calls can still be temporary; their raw text is never read.
const INSTALL_FAILURES = new Set(['ENOENT','EACCES','EPERM','ENOEXEC','ENOTDIR','EISDIR','ELOOP','ENAMETOOLONG']);
const DIAGNOSTIC_CODES = new Set([...TRANSIENT,'stale_generation','binding_mismatch','binding_ambiguous','binding_conflict',
  'not_found','invalid_argument','permission_denied','unsupported','unsupported_host_version','incompatible_adapter',
  'delivery_uncertain','commit_uncertain','protocol_conflict','invalid_transition','protocol_error','lease_invalid',
  'revision_conflict','question_changed','unhandled_owner_message','invalid_ref','operation_reused','result_already_committed',
  'attempt_sealed','result_missing','queue_full','topic_not_archivable','session_not_closable','preview_stale','snapshot_changed',
  'capacity_exceeded','corrupt_session','future_schema','control_path_too_long']);
// The integration table checks every generated CoreErrorCode against this set.
export function failureCode(error) {
  if (error?.details?.reason === 'lease_invalid') return 'lease_invalid';
  if (INSTALL_FAILURES.has(error?.code) || INSTALL_FAILURES.has(error?.cause?.code)) return 'incompatible_adapter';
  if (DIAGNOSTIC_CODES.has(error?.code)) return error.code;
  return error instanceof ModError ? 'protocol_error' : 'process_rejected';
}
// Owner-operation receipts retain their own history and write queue.
let diagnostics = Promise.resolve();
export function connectDiagnostic($, record) {
  const append = diagnostics.then(async () => {
    try {
      const previous = await $.store.get('connect-log');
      const records = Array.isArray(previous) ? previous.slice(-19) : [];
      records.push(record);
      await $.store.set('connect-log',records);
    } catch { /* diagnostics never change retry authority */ }
  });
  diagnostics = append;
  return append;
}
// Background diagnostics must neither evict owner receipts nor hold up intake.
// Bound the pending queue too, in case a store promise never settles.
const backgroundRecords = [];
let backgroundWriting = false;
export function backgroundDiagnostic($, record) {
  if (backgroundRecords.length === 20) backgroundRecords.shift();
  backgroundRecords.push({store:$.store,record});
  if (backgroundWriting) return;
  backgroundWriting = true;
  void (async () => {
    try {
      while (backgroundRecords.length) {
        const {store,record} = backgroundRecords.shift();
        try {
          const previous = await store.get('hook-log');
          const records = Array.isArray(previous) ? previous.slice(-19) : [];
          records.push(record);
          await store.set('hook-log',records);
        } catch { /* best effort; no retry authority */ }
      }
    } finally { backgroundWriting = false; }
  })().catch(() => {});
}
export const BACKGROUND_RETRY = 'Ariadne is having trouble keeping this conversation up to date; it will keep trying, and you can open Ariadne to check on it.';
// The one fixed helper message recognised by plainFailure: its retry keeps these words.
const FOLDER_FAILURE = 'The project folder is missing or inaccessible. Restore access or select it again; Ariadne will keep trying.';
export function folderFailure(error) {
  return error?.plain === FOLDER_FAILURE;
}
// A helper call is killed after HELPER_TIMEOUT_MS. One call of a producer can
// run several helper calls one after another. The counts below are typical,
// not maxima: a turn callback's start saves two events (accepted, then
// started), a report flush typically saves up to five (accepted, started,
// finished, one late conflict, the end), and an automatic reconnect typically
// drains retired reports, registers the project, connects and waits for the
// route. A larger backlog can run more. A call is hung once it has outlasted
// the kills of its producer's typical helper runs, plus two seconds.
const HELPER_RUNS = Object.freeze({announce:1,helper:2,qualification:1,claim:1,reports:5,auto:8});
export const HUNG_CALL_MS = Object.freeze(Object.fromEntries(Object.entries(HELPER_RUNS)
  .map(([producer,runs]) => [producer,runs * HELPER_TIMEOUT_MS + 2000])));
const PRODUCERS = Object.freeze(['announce','helper','auto','qualification','claim','reports']);
// Held codes whose advice the owner must act on. Other held codes, such as
// protocol_error, wait out the grace and spacing like retries do.
const OWNER_HELD = new Set(['invalid_transition','binding_conflict','stale_generation','binding_mismatch','binding_ambiguous',
  'not_found','permission_denied','unsupported','unsupported_host_version','delivery_uncertain','commit_uncertain','protocol_conflict']);
// Owner-needed held advice outranks generic held advice; urgent meanings rank 3 and up.
function rank(condition) {
  if (condition.kind === 'held') return OWNER_HELD.has(condition.code) ? 3 : 2;
  return {ok:0,transient:1,install:4,terminal:5}[condition.kind];
}
const urgent = condition => rank(condition) >= 3;
// A turn callback is not run again when it fails (its unsaved reports are retried by the report producer), so its
// line makes no promise to keep trying.
export const TURN_FAILURE = 'Ariadne could not record what just happened in this conversation. Open Ariadne to check on it.';
// Transient lines are the shared retry sentence, the project-folder sentence, or the turn callback's own.
const retryLine = text => text === FOLDER_FAILURE || text === TURN_FAILURE ? text : BACKGROUND_RETRY;
// The line a hung call shows: a hung turn callback ('helper') is not run again either.
const hungLine = producer => producer === 'helper' ? TURN_FAILURE : BACKGROUND_RETRY;
// The kind comes from the error code alone, never from `retryable` or the hint.
// The text is a fixed sentence: plainFailure may pick one from a fixed helper
// message, but never echoes it. Background retries never inherit connect advice.
export function backgroundOutcome(error, text, {terminal = false} = {}) {
  const code = failureCode(error);
  if (text === null || code === 'lease_invalid') return {kind:'ok'};
  if (terminal) return {kind:'terminal',code,text:text ?? plainFailure(code,error?.details)};
  if (code === 'incompatible_adapter') return {kind:'install',code,text:plainFailure(code)};
  if (TRANSIENT.has(code)) return {kind:'transient',code,text:retryLine(folderFailure(error) ? FOLDER_FAILURE : text)};
  return {kind:'held',code,text:code === 'invalid_transition' ? plainFailure(code,error?.details) : text ?? plainFailure(code,error?.details)};
}
// One conversation record. Liveness has one rule: every call records exactly
// one outcome, and a producer counts from its first outcome until it is
// retired (its loop stopped, its binding ended, it qualified, or reset). A call open longer
// than its producer's HUNG_CALL_MS counts as a temporary timeout for its producer until it
// ends. Printing remembers continuous ill health, the last line, its producer
// and the spacing of non-urgent lines.
export function conversationHealth(now = () => Date.now()) {
  // The latest recorded outcome of each producer that has not been retired.
  const producers = new Map();
  // The calls each producer has open now, by the time each started.
  const calls = new Map();
  let unhealthySince = null, lastLine = null, quietAt = null, shown = null;
  // A producer's outcome as selection sees it: a hung call counts as a timeout.
  function outcome(producer) {
    const open = [...calls.get(producer) ?? []].map(call => call.startedAt);
    const oldest = open.length ? Math.min(...open) : Infinity;
    if (now() - oldest > HUNG_CALL_MS[producer]) return {kind:'transient',code:'timeout',text:hungLine(producer),failedAt:oldest + HUNG_CALL_MS[producer]};
    return producers.get(producer);
  }
  function failing() {
    return PRODUCERS.map(producer => [producer,outcome(producer)]).filter(([,value]) => value && value.kind !== 'ok');
  }
  function current() {
    const candidates = failing();
    if (!candidates.length) return {kind:'ok'};
    candidates.sort(([left,a],[right,b]) => rank(b) - rank(a) || b.failedAt - a.failedAt || PRODUCERS.indexOf(left) - PRODUCERS.indexOf(right));
    // The line showing now stays while its producer still fails and is at least
    // as urgent as every other candidate.
    const kept = candidates.find(([producer,value]) => producer === shown?.producer && rank(value) >= rank(candidates[0][1]));
    const [producer,value] = kept ?? candidates[0];
    return {kind:value.kind,code:value.code,text:value.kind === 'transient' ? retryLine(value.text) : value.text,producer};
  }
  function evaluate($) {
    const condition = current();
    if (condition.kind === 'ok') {
      if (unhealthySince !== null) backgroundDiagnostic($,{step:'health',outcome:'recovered',code:'ok',at:new Date(now()).toISOString()});
      unhealthySince = null;
      lastLine = null;
      shown = null;
      return condition;
    }
    if (unhealthySince === null) {
      unhealthySince = now();
      backgroundDiagnostic($,{step:condition.producer,outcome:'started',code:condition.code,at:new Date(now()).toISOString()});
    }
    const quiet = !urgent(condition);
    if (condition.text === lastLine) return condition;
    if (quiet && (now() - unhealthySince < NOTICE_GRACE_MS || (quietAt !== null && now() - quietAt < NOTICE_GRACE_MS))) return condition;
    // A retry line never replaces held, installation or terminal advice while
    // the producer that printed it still fails.
    if (condition.kind === 'transient' && shown && shown.kind !== 'transient' && failing().some(([producer]) => producer === shown.producer)) return condition;
    if (lastLine !== null) backgroundDiagnostic($,{step:condition.producer,outcome:'changed',code:condition.code,at:new Date(now()).toISOString()});
    $.ui.log(condition.text);
    lastLine = condition.text;
    shown = {producer:condition.producer,kind:condition.kind};
    if (quiet) quietAt = now();
    return condition;
  }
  // Opens one call of a producer and returns the function that settles it with
  // its one outcome. A call settled after its producer retired records nothing.
  function call($, producer) {
    if ($.background === false) return () => {};
    const open = {startedAt:now()};
    if (!calls.has(producer)) calls.set(producer,new Set());
    calls.get(producer).add(open);
    evaluate($);
    return outcome => {
      if (!calls.get(producer)?.delete(open)) return;
      const previous = producers.get(producer);
      if (outcome.kind === 'ok' && previous?.kind === 'transient' && previous.good < 2) producers.set(producer,{...previous,good:previous.good + 1});
      else producers.set(producer,{...outcome,failedAt:now(),good:0});
      return evaluate($);
    };
  }
  return {
    current,
    call,
    // One call that took no time.
    record($, producer, outcome) { return call($,producer)(outcome); },
    // The producer stops counting, and its open calls record nothing. An owner
    // command may retire a producer whose loop it stopped, but prints nothing.
    retire($, producer) {
      producers.delete(producer);
      calls.delete(producer);
      if ($.background !== false) return evaluate($);
    },
    reset() {producers.clear();calls.clear();unhealthySince = null;lastLine = null;quietAt = null;shown = null;},
  };
}
// Owner-facing sentence per helper error code, each with a next step. Raw helper
// text is never shown; one fixed helper message, a missing project folder, is
// recognised to pick its own fixed sentence.
const GENERIC_FAILURE = 'Ariadne ran into a problem and could not record this. Open the Ariadne app to see what happened; if it keeps happening, update Ariadne.';
const MISMATCH_FAILURE = "Ariadne and its Claude plugin don't match, so this was not recorded. Update both to the same version.";
const UNREADABLE_FAILURE = "Ariadne's reply was cut off or unreadable, so this was not recorded. Open Ariadne and try again; if it keeps happening, update Ariadne.";
const TIMEOUT_FAILURE = 'Ariadne took too long to answer. Open Ariadne, then try again.';
const GONE_FAILURE ="This conversation's link to its Ariadne session is out of date or was removed. Run /ariadne-connect to connect it again.";
const UNCERTAIN_FAILURE = "Ariadne couldn't confirm that its last step was saved. Open Ariadne and check before sending anything again.";
const HELD_FAILURES = Object.freeze({
  owner_paused: 'Sending to this Ariadne session is paused in the app. Resume it in Ariadne and messages will arrive here.',
  session_closed: 'This Ariadne session is closed in the app. Reopen it in Ariadne and messages will arrive here.',
  recovery_required: 'A message to this Ariadne session needs your attention in the app. Open Ariadne to sort it out.',
});
const HELPER_FAILURES = Object.freeze({
  host_unreachable: 'Open the Ariadne app, then run /ariadne-connect again.',
  stale_generation: GONE_FAILURE,
  binding_mismatch: "Ariadne could not use this conversation's project folder or session link. Check that its project folder is available, then run /ariadne-connect again.",
  binding_ambiguous: GONE_FAILURE,
  binding_conflict: 'Ariadne has this session connected to another Claude conversation, maybe one you cleared. In Ariadne, click the dot by the session name, choose Connection… (or Sending…), then Disconnect. Then run /ariadne-connect here followed by the session ID (Copy session ID in Ariadne).',
  not_found: "Ariadne can't find that session. Open Ariadne to check it still exists, then run /ariadne-connect.",
  invalid_argument: "Ariadne didn't accept that request. Run /ariadne-connect again; if it keeps happening, update the Ariadne app and plugin so they match.",
  permission_denied: "Ariadne isn't allowed to do that. Open the Ariadne app to check what is allowed for this session.",
  unsupported: "This version of Claude Code or Ariadne can't do that yet. Update Claude Code and the Ariadne app, then try again.",
  unsupported_host_version: "This version of Claude Code or Ariadne can't do that yet. Update Claude Code and the Ariadne app, then try again.",
  incompatible_adapter: MISMATCH_FAILURE,
  delivery_uncertain: UNCERTAIN_FAILURE,
  commit_uncertain: UNCERTAIN_FAILURE,
  protocol_conflict: 'Ariadne and Claude disagree about this session, so it is paused. Open Ariadne to review it.',
  store_busy: 'Ariadne is busy with something else right now. Wait a moment, then try again.',
});
// A refusal of the app to take more work: the reason says what to do, not the code.
export function plainFailure(code, details, message) {
  if (code === 'host_unreachable' && typeof message === 'string' && message.toLowerCase().includes('project folder is missing or inaccessible')) {
    return FOLDER_FAILURE;
  }
  const own = (table, key) => typeof key === 'string' && Object.hasOwn(table,key) ? table[key] : undefined;
  if (code === 'binding_conflict' && bounded(details?.connected_session_name,4096)
    && !/\p{Cc}/u.test(details.connected_session_name)) {
    return `This conversation is already connected to ${details.connected_session_name}. Reconnect to that session, or start another Claude conversation to use a different Ariadne session.`;
  }
  if (code === 'invalid_transition') {
    return own(HELD_FAILURES,details?.reason) ?? 'Ariadne is holding messages for this session right now. Open Ariadne to see why.';
  }
  return own(HELPER_FAILURES,code) ?? GENERIC_FAILURE;
}
const encoder = new globalThis.TextEncoder();
export function bytes(text) { return encoder.encode(text).byteLength; }
export function uuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
export function bounded(value, limit = 4096) {
  return typeof value === 'string' && value.trim().length > 0 && bytes(value) <= limit;
}
export function fields(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}
export async function hash(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}
export function descriptorValid(descriptor, plugin) {
  return fields(descriptor, ['helperPath', 'appVersion', 'apiVersion'])
    && bounded(descriptor.helperPath) && descriptor.helperPath.startsWith('/')
    && descriptor.helperPath.split('/').every(part => part !== '.' && part !== '..')
    && bounded(descriptor.appVersion) && fields(plugin,['name','root']) && plugin.name === 'ariadne'
    && bounded(plugin.root) && plugin.root.startsWith('/')
    && plugin.root.split('/').every(part => part !== '.' && part !== '..')
    && descriptor.apiVersion === API_VERSION;
}
export function envelope(result) {
  if (!result || result.isStdoutTruncated || result.isStderrTruncated
    || typeof result.stdout !== 'string' || bytes(result.stdout) > 1024 * 1024) {
    throw new ModError('Ariadne helper returned incomplete or oversized output; retain pending request/event IDs.',UNREADABLE_FAILURE);
  }
  // A helper killed before it wrote anything (exit status null) timed out;
  // that is temporary, not an unreadable reply.
  if (result.exitCode === null && result.stdout === '') {
    const failure = new ModError('Ariadne helper was stopped before it answered; retain pending request/event IDs.',TIMEOUT_FAILURE);
    failure.code = 'timeout';
    throw failure;
  }
  let value;
  try { value = JSON.parse(result.stdout); }
  catch { throw new ModError('Ariadne helper returned malformed JSON; retain pending request/event IDs.',UNREADABLE_FAILURE); }
  if (value?.api_version !== API_VERSION || typeof value.ok !== 'boolean') {
    const failure = new ModError('Ariadne helper API version/envelope is incompatible; update the installed app and Mod.',MISMATCH_FAILURE);
    if (value?.api_version !== API_VERSION) failure.code = 'incompatible_adapter';
    throw failure;
  }
  if (!value.ok) {
    const error = value.error;
    if (!fields(value, ['api_version','ok','error']) || !error || typeof error !== 'object'
      || !Object.keys(error).every(key => ['code','message','hint','retryable','field_errors','current_revision','details'].includes(key))
      || !bounded(error.code, 64) || !bounded(error.message) || !bounded(error.hint)
      || !Array.isArray(error.field_errors) || error.field_errors.length > 100
      || !error.field_errors.every(field => fields(field, ['field','message']) && bounded(field.field) && bounded(field.message))
      || typeof error.retryable !== 'boolean'
      || (['delivery_uncertain','commit_uncertain'].includes(error.code) && error.retryable)) {
      throw new ModError('Ariadne helper returned an invalid error; retain original IDs and check app/helper versions.',MISMATCH_FAILURE);
    }
    // Do not reflect raw helper diagnostics, provider text or a retry suggestion.
    const known = ['delivery_uncertain','commit_uncertain','host_unreachable','unsupported','protocol_conflict','stale_generation','permission_denied','invalid_argument','not_found'];
    const label = known.includes(error.code) ? ` (${error.code})` : '';
    const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details) ? error.details : null;
    const failure = new ModError(`Ariadne helper failed${label}; retain original IDs and inspect the app.`,plainFailure(error.code,details,error.message));
    failure.code = error.code;
    failure.details = details;
    throw failure;
  }
  if (result.exitCode !== 0 || !fields(value, ['api_version','ok','data'])) {
    throw new ModError('Ariadne helper success envelope/exit status disagrees; retain original IDs.',UNREADABLE_FAILURE);
  }
  return value.data;
}
export async function prepared(value, binding) {
  if (!fields(value, ['input_id','attempt_id','binding_generation','formatted_payload','payload_sha256','wire_marker'])
    || !uuid(value.input_id) || !uuid(value.attempt_id) || value.binding_generation !== binding.generation
    || typeof value.formatted_payload !== 'string' || bytes(value.formatted_payload) > 64 * 1024
    || value.wire_marker !== `[ARIADNE_INPUT:${value.input_id}:${value.attempt_id}]`
    || !value.formatted_payload.startsWith(`${value.wire_marker}\n`)
    || !/^[0-9a-f]{64}$/.test(value.payload_sha256)
    || await hash(value.formatted_payload) !== value.payload_sha256) {
    throw new ModError('Ariadne claim payload/identity proof is invalid; retain the claim request ID and recover in the app.');
  }
  return value;
}
export function reportReceipt(value, event, session) {
  if (!fields(value, ['event_id','session_id','revision','durable_effect','replayed'])
    || value.event_id !== event.event_id || value.session_id !== session.session_id
    || typeof value.durable_effect !== 'boolean'
    || (value.revision !== null && (!Number.isSafeInteger(value.revision) || value.revision < 1))
    || (value.durable_effect && value.revision === null)
    || typeof value.replayed !== 'boolean') {
    throw new ModError('Ariadne lifecycle report lacks a matching validated receipt; retain the exact event.');
  }
  return value;
}
export function clip(text, limit = 64 * 1024) {
  if (typeof text !== 'string') return { text: '', truncated: false };
  // Iterate Unicode scalars so neither surrogate pairs nor UTF8 sequences split.
  let result = ''; let length = 0;
  for (const character of text) {
    const size = bytes(character);
    if (length + size > limit) break;
    result += character; length += size;
  }
  return { text: result, truncated: result.length !== text.length };
}
export async function lifecycle(scope, claim, kind, payload, turn = null) {
  const identity = ['turn_finished','rejected','uncertain'].includes(kind)
    ? [scope.binding_id,scope.generation,claim.attempt_id,turn,kind]
    : ['claude-mod',scope.binding_id,scope.generation,claim.attempt_id,turn,kind];
  return { event_id: await hash(JSON.stringify(identity)), binding_id: scope.binding_id,
    generation: scope.generation, input_id: claim.input_id, attempt_id: claim.attempt_id,
    host_turn_id: turn, observed_at: new Date().toISOString(), kind, payload };
}
