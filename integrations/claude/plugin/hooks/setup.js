import { API_VERSION, HOST_VERSION, ModError, bounded, descriptorValid, envelope, fields, hostVersionStatus, uuid } from './contracts.js';

export async function qualify($, descriptor) {
  if (!descriptorValid(descriptor,$.plugin)) {
    throw new ModError('Installed helper descriptor is missing or incompatible.','Update Ariadne and its Claude plugin so they match, then run /ariadne-connect again.');
  }
  if (hostVersionStatus((await $.session.version()).version) === null) {
    throw new ModError(`This Mod requires Claude Code ${HOST_VERSION} or newer; update Claude Code.`,`Update Claude Code to ${HOST_VERSION} or newer, then run /ariadne-connect again.`);
  }
  const result = await $.process.run([descriptor.helperPath,'--version'],{timeoutMs:5000});
  if (result.exitCode !== 0 || result.isStdoutTruncated || result.isStderrTruncated
    || result.stdout !== `ariadne ${descriptor.appVersion}\n`) {
    throw new ModError('Installed Ariadne helper/Mod versions disagree; reinstall matching resources.','Update Ariadne and its Claude plugin so they match, then run /ariadne-connect again.');
  }
}
function command(name, params) {
  return {api_version:API_VERSION,op_id:globalThis.crypto.randomUUID(),command:name,params};
}
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
// The core accepts a setup instruction up to 64 KiB (bindings/mod.rs); the
// shipped Claude rules plus routing IDs are already past the 4 KiB default.
const INSTRUCTION_LIMIT = 64 * 1024;
function capabilities(value) {
  const names = ['existing_session','deferred_delivery','turn_correlation','turn_completion','domain_cli','domain_mcp','history_reconcile','streaming_output','final_text_read','discover_sessions'];
  return fields(value,[...names,'delivery_mode']) && value.delivery_mode === 'pull'
    && names.every(name => fields(value[name],['supported','conditions'])
      && typeof value[name].supported === 'boolean' && Array.isArray(value[name].conditions)
      && value[name].conditions.length <= 100 && value[name].conditions.every(condition => bounded(condition)));
}
export function bindingStatus(value, binding) {
  if (!fields(value,['id','adapter_id','external_session_id','generation','dispatch_state','owner_paused','pause_reason','connection_state','presence'])
    || value.id !== binding.binding_id || value.generation !== binding.generation
    || value.external_session_id !== binding.external_session_id || value.adapter_id !== 'claude_code_mod'
    || !['enabled','paused','recovery_required','disconnected'].includes(value.dispatch_state)
    || !['connected','disconnected','reconnecting','unknown'].includes(value.connection_state)
    || typeof value.owner_paused !== 'boolean') {
    throw new ModError('Ariadne status differs from the registered original session; retain IDs and recover in the app.');
  }
  return value;
}
// A reachable app has no current route for these saved coordinates. This says
// nothing about message delivery; Core retains and reconciles its attempts.
export function connectionGone(error) {
  return error instanceof ModError && ['not_found','stale_generation','binding_mismatch'].includes(error.code);
}
// Which Ariadne session each Claude conversation was connected to, kept in the
// plugin's own store (never ~/.ariadne) so `claude --resume` reconnects it.
// Lives here, not in its own module: the installed Mod's file set is fixed.
const MEMORY_PREFIX = 'binding:';
const MEMORY_LIMIT = 50;
function memoryKey(claudeSessionId) {
  return bounded(claudeSessionId,200) ? MEMORY_PREFIX + claudeSessionId : null;
}
export async function recall($, claudeSessionId) {
  const name = memoryKey(claudeSessionId);
  if (name === null) return null;
  try {
    const value = await $.store.get(name);
    return fields(value,['project_id','session_id','saved_at']) && uuid(value.project_id) && uuid(value.session_id)
      ? {project_id:value.project_id,session_id:value.session_id} : null;
  } catch { return null; }
}
export async function remember($, claudeSessionId, session) {
  const name = memoryKey(claudeSessionId);
  if (name === null) return;
  try {
    await $.store.set(name,{project_id:session.project_id,session_id:session.session_id,saved_at:new Date().toISOString()});
    const names = (await $.store.keys()).filter(entry => typeof entry === 'string' && entry.startsWith(MEMORY_PREFIX));
    if (names.length <= MEMORY_LIMIT) return;
    const dated = await Promise.all(names.map(async entry => [entry,(await $.store.get(entry))?.saved_at ?? '']));
    dated.sort((a,b) => String(a[1]).localeCompare(String(b[1])));
    for (const [entry] of dated.slice(0,dated.length - MEMORY_LIMIT)) await $.store.delete(entry);
  } catch { /* best effort: a lost entry only means no automatic reconnect */ }
}
export async function forget($, claudeSessionId) {
  const name = memoryKey(claudeSessionId);
  if (name === null) return;
  try { await $.store.delete(name); } catch { /* best effort */ }
}
export function setup(helperPath, savedBinding = async () => {}, publish = {waitMs:15000,pollMs:250}) {
  let projectRequest = null;
  let projectId = null;
  let connectRequest = null;
  let binding = null;
  let disconnectRequest = null;
  async function owner($, noun, verb, request, replayOnly = false) {
    try {
      const value = envelope(await $.process.run([helperPath,noun,verb,...(replayOnly ? ['--replay-only'] : []),'--json-stdin'],
        {stdin:JSON.stringify(request),timeoutMs:5000}));
      await diagnostic($,request.command.op_id,replayOnly ? 'lookup' : verb,'ok');
      return value;
    } catch (error) {
      await diagnostic($,request.command.op_id,replayOnly ? 'lookup' : verb,error?.code ?? 'unknown');
      throw error;
    }
  }
  async function diagnostic($, operationId, step, outcome) {
    try {
      const previous = await $.store.get('connect-log');
      const records = Array.isArray(previous) ? previous.slice(-19) : [];
      records.push({operation_id:operationId,step,outcome,at:new Date().toISOString()});
      await $.store.set('connect-log',records);
    } catch { /* diagnostics never change retry authority */ }
  }
  async function status($, selected = binding) {
    if (!selected) throw new ModError('Run /ariadne-connect in this original conversation first.','This conversation is not connected to Ariadne. Run /ariadne-connect to connect it.');
    const value = envelope(await $.process.run([helperPath,'bridge','connection-status',
      '--binding',selected.binding_id,'--generation',selected.generation,
      '--request-id',globalThis.crypto.randomUUID()],{timeoutMs:5000}));
    return bindingStatus(value,selected);
  }
  // The app publishes the route only after the bound announcement and history
  // reconciliation finish; until then status reports not_found. Wait, bounded.
  async function published($, selected) {
    const until = Date.now() + publish.waitMs;
    for (;;) {
      try { return await status($,selected); }
      catch (error) {
        if (error?.code !== 'not_found' || Date.now() >= until) throw error;
        await new Promise(resolve => setTimeout(resolve,publish.pollMs));
      }
    }
  }
  async function connect($, requestedSessionId = null) {
    if (requestedSessionId !== null && !uuid(requestedSessionId)) {
      throw new ModError('Choose an explicit canonical Ariadne session UUID, or omit it to connect normally.');
    }
    if (disconnectRequest) throw new ModError('An original disconnect operation is pending.','Run /ariadne-disconnect again to finish disconnecting, then run /ariadne-connect.');
    const targetSessionId = requestedSessionId ?? binding?.session.session_id ?? null;
    const externalSession = await $.session.id();
    const cwd = await $.session.cwd();
    if (!bounded(externalSession) || !bounded(cwd) || !cwd.startsWith('/')) {
      throw new ModError('Claude did not provide a valid original session ID and absolute project directory.');
    }
    projectRequest ??= {session:null,command:command('project_register',{canonical_root:cwd})};
    if (projectRequest.command.params.canonical_root !== cwd) {
      throw new ModError('Session/project changed with a pending owner operation; recover the original operation in the app.');
    }
    if (projectId === null) {
      const receipt = await owner($,'project','register',projectRequest);
      if (!fields(receipt,['operation_id','project_id','registry_revision'])
        || receipt.operation_id !== projectRequest.command.op_id || !uuid(receipt.project_id)
        || !positive(receipt.registry_revision)) {
        throw new ModError('Project registration did not return its exact canonical receipt; retain the original operation ID.');
      }
      projectId = receipt.project_id;
    }
    if (connectRequest) {
      const changed = connectRequest.command.params.existing_session_id !== targetSessionId
        || connectRequest.command.params.external_session_id !== externalSession;
      // Never execute an obsolete request to discover whether it committed.
      let saved;
      try { saved = await owner($,'binding','connect',connectRequest,true); }
      catch (error) {
        if (!changed) throw error;
        // A removed session can fail lookup with io_error. Core fences fresh
        // competing requests even when lookup fails or an old call commits late.
        connectRequest = null;
      }
      if (connectRequest && saved !== null) {
        const selected = selection(saved,connectRequest);
        try {
          const current = await status($,selected);
          if (changed || current.connection_state === 'disconnected' || current.dispatch_state === 'disconnected') connectRequest = null;
        } catch (error) {
          // not_found/lease_invalid also means activation has not published its
          // route yet. Preserve unchanged publication retries in that case.
          if (connectionGone(error) && (changed || error.code !== 'not_found' || error.details?.reason === 'session_removed')) connectRequest = null;
          else if (error?.code === 'not_found') { /* retry the original announcement below */ }
          else throw error;
        }
      } else if (changed) connectRequest = null;
      // A missing receipt on an unchanged request may still be in flight.
      // Keep its exact body and ID; Core fences competing changed requests.
    }
    connectRequest ??= {session:null,command:command('binding_connect',{
      project_id:projectId,adapter_id:'claude_code_mod',external_session_id:externalSession,
      endpoint:{kind:'local_bridge',name:'claude-mod'},configuration:{namespace:'claude_code_mod',values:{}},
      existing_session_id:targetSessionId,
    })};
    const receipt = await owner($,'binding','connect',connectRequest);
    const selected = selection(receipt,connectRequest);
    if (targetSessionId !== null && receipt.session_id !== targetSessionId) {
      throw new ModError('Binding receipt differs from the explicit Ariadne session; retain the original operation ID and recover that target in the app.');
    }
    let projection;
    try {
      await savedBinding($,selected);
      projection = await published($,selected);
    } catch (error) {
      const failure = new ModError(`Ariadne binding ${selected.binding_id} was saved; connection status remains pending. Original operation ${connectRequest.command.op_id}. ${error?.code ?? 'unknown'}`,
        'Ariadne has not finished connecting this conversation. Run /ariadne-connect again; if it keeps happening, check this session in Ariadne.');
      if (error instanceof ModError && error.code === 'host_unreachable') failure.code = error.code;
      throw failure;
    }
    binding = selected;
    connectRequest = null;
    disconnectRequest = null;
    return {binding,status:projection};
  }
  function selection(receipt, request) {
    const data = receipt?.data;
    if (!fields(receipt,['operation_id','session_id','revision','data'])
      || receipt.operation_id !== request.command.op_id || !uuid(receipt.session_id) || !positive(receipt.revision)
      || !fields(data,['kind','binding_id','generation','capabilities','setup_instruction'])
      || data.kind !== 'binding_connect' || !uuid(data.binding_id) || !uuid(data.generation)
      || !capabilities(data.capabilities) || !bounded(data.setup_instruction,INSTRUCTION_LIMIT)) {
      throw new ModError('Binding connect did not return its exact canonical saved receipt; retain the original operation ID.');
    }
    if (request.command.params.existing_session_id !== null && receipt.session_id !== request.command.params.existing_session_id) {
      throw new ModError('Binding receipt differs from the explicit Ariadne session; retain the original operation ID and recover that target in the app.');
    }
    return {binding_id:data.binding_id,generation:data.generation,external_session_id:request.command.params.external_session_id,
      session:{project_id:request.command.params.project_id,session_id:receipt.session_id}};
  }
  async function disconnect($) {
    if (!binding) throw new ModError('No registered Ariadne binding is connected locally.');
    disconnectRequest ??= {session:binding.session,command:command('binding_disconnect',{
      binding_id:binding.binding_id,expected_generation:binding.generation})};
    const receipt = await owner($,'binding','disconnect',disconnectRequest);
    if (!fields(receipt,['operation_id','session_id','revision','data'])
      || receipt.operation_id !== disconnectRequest.command.op_id || receipt.session_id !== binding.session.session_id
      || !positive(receipt.revision) || receipt.data?.kind !== 'binding_state'
      || receipt.data.binding_id !== binding.binding_id || !uuid(receipt.data.generation)
      || receipt.data.connection_state !== 'disconnected') {
      throw new ModError('Disconnect lacks a matching canonical receipt; retain the original operation ID.');
    }
    binding = null;
    disconnectRequest = null;
    return receipt;
  }
  // A new Claude conversation replaced the bound one (/clear, /resume): its
  // connection and any operation retained for the old conversation no longer apply.
  function forget() {
    binding = null;
    connectRequest = null;
    disconnectRequest = null;
  }
  return {connect,status,disconnect,forget,current:() => binding};
}
