import { API_VERSION, HOST_VERSION, ModError, bounded, descriptorValid, envelope, fields, hostVersionStatus, uuid } from './contracts.js';

export async function qualify($, descriptor) {
  if (!descriptorValid(descriptor,$.plugin)) {
    throw new ModError('Install the matching Ariadne app and Mod; the installed helper descriptor is missing or incompatible.');
  }
  if (hostVersionStatus((await $.session.version()).version) === null) {
    throw new ModError(`This Mod requires Claude Code ${HOST_VERSION} or newer; update Claude Code.`);
  }
  const result = await $.process.run([descriptor.helperPath,'--version'],{timeoutMs:5000});
  if (result.exitCode !== 0 || result.isStdoutTruncated || result.isStderrTruncated
    || result.stdout !== `ariadne ${descriptor.appVersion}\n`) {
    throw new ModError('Installed Ariadne helper/Mod versions disagree; reinstall matching resources.');
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
export function setup(helperPath, savedBinding = async () => {}, publish = {waitMs:15000,pollMs:250}) {
  let projectRequest = null;
  let projectId = null;
  let connectRequest = null;
  let binding = null;
  let disconnectRequest = null;
  async function owner($, noun, verb, request) {
    return envelope(await $.process.run([helperPath,noun,verb,'--json-stdin'],
      {stdin:JSON.stringify(request),timeoutMs:5000}));
  }
  async function status($, selected = binding) {
    if (!selected) throw new ModError('Run /ariadne-connect in this original conversation first.');
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
    if (disconnectRequest) throw new ModError('An original disconnect operation is pending; retry disconnect with its retained operation ID before reconnecting.');
    const targetSessionId = requestedSessionId ?? binding?.session.session_id ?? null;
    if (connectRequest && connectRequest.command.params.existing_session_id !== targetSessionId) {
      throw new ModError('The original connect operation targets a different session; retain its operation ID and retry that exact target.');
    }
    const externalSession = await $.session.id();
    const cwd = await $.session.cwd();
    if (!bounded(externalSession) || !bounded(cwd) || !cwd.startsWith('/')) {
      throw new ModError('Claude did not provide a valid original session ID and absolute project directory.');
    }
    projectRequest ??= {session:null,command:command('project_register',{canonical_root:cwd})};
    if (projectRequest.command.params.canonical_root !== cwd
      || (connectRequest && connectRequest.command.params.external_session_id !== externalSession)) {
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
    connectRequest ??= {session:null,command:command('binding_connect',{
      project_id:projectId,adapter_id:'claude_code_mod',external_session_id:externalSession,
      endpoint:{kind:'local_bridge',name:'claude-mod'},configuration:{namespace:'claude_code_mod',values:{}},
      existing_session_id:targetSessionId,
    })};
    const receipt = await owner($,'binding','connect',connectRequest);
    const data = receipt?.data;
    if (!fields(receipt,['operation_id','session_id','revision','data'])
      || receipt.operation_id !== connectRequest.command.op_id || !uuid(receipt.session_id) || !positive(receipt.revision)
      || !fields(data,['kind','binding_id','generation','capabilities','setup_instruction'])
      || data.kind !== 'binding_connect' || !uuid(data.binding_id) || !uuid(data.generation)
      || !capabilities(data.capabilities) || !bounded(data.setup_instruction,INSTRUCTION_LIMIT)) {
      throw new ModError('Binding connect did not return its exact canonical saved receipt; retain the original operation ID.');
    }
    if (targetSessionId !== null && receipt.session_id !== targetSessionId) {
      throw new ModError('Binding receipt differs from the explicit Ariadne session; retain the original operation ID and recover that target in the app.');
    }
    const selected = {binding_id:data.binding_id,generation:data.generation,external_session_id:externalSession,
      session:{project_id:projectId,session_id:receipt.session_id}};
    let projection;
    try {
      // Publish only the exact validated saved IDs. Native qualification and
      // reconciliation must finish before route-dependent status can succeed.
      await savedBinding($,selected);
      projection = await published($,selected);
    } catch (error) {
      throw new ModError(`Ariadne binding ${selected.binding_id} was saved; connection status remains pending. Retry /ariadne-connect with the same session selector when the app is ready; the original operation ID is retained.${error instanceof ModError ? ` ${error.message}` : ''}`);
    }
    binding = selected;
    connectRequest = null;
    disconnectRequest = null;
    return {binding,status:projection};
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
  return {connect,status,disconnect};
}
