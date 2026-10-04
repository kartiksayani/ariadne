// Read-only heartbeats over the existing private bridge; no binding or queue authority.
import { API_VERSION, ModError, bounded, envelope, fields, uuid } from './contracts.js';

function absolute(value) {
  return bounded(value) && !value.includes('\0') && value.startsWith('/')
    && value.split('/').every(part => part !== '.' && part !== '..');
}
function descriptorValid(descriptor) {
  return fields(descriptor, ['helperPath','appVersion','apiVersion'])
    && absolute(descriptor.helperPath) && bounded(descriptor.appVersion)
    && !descriptor.appVersion.includes('\0') && descriptor.apiVersion === API_VERSION;
}
function originalScope(scope) {
  if (scope === null) return null;
  if (!fields(scope,['binding_id','generation']) || !uuid(scope.binding_id) || !uuid(scope.generation)) {
    throw new ModError('Discovery requires the original validated binding scope; never infer a binding.');
  }
  return {...scope};
}

export function announcements(descriptor) {
  let stopped = false;
  let pending = false;
  return {
    async announce($, bindingScope = null) {
      // Coalesce timer ticks, rather than retaining an unbounded helper job list.
      // A skipped heartbeat is never an acknowledgement for another scope.
      if (stopped || pending) return false;
      pending = true;
      try {
        if (!descriptorValid(descriptor)) {
          throw new ModError('Install matching immutable Ariadne resources before discovery; the helper descriptor is missing or invalid.');
        }
        const plugin = {name:$.plugin?.name,root:$.plugin?.root};
        if (plugin.name !== 'ariadne' || !absolute(plugin.root)) {
          throw new ModError('Claude did not supply the loaded Ariadne plugin name and absolute root; reload the installed Mod.');
        }
        const binding_scope = originalScope(bindingScope);
        const external_session_id = await $.session.id();
        const cwd = await $.session.cwd();
        const host_version = (await $.session.version())?.version;
        if (!bounded(external_session_id) || external_session_id.includes('\0')
          || !absolute(cwd) || !bounded(host_version) || host_version.includes('\0')) {
          throw new ModError('Claude discovery lacks bounded original session, project or version facts.');
        }
        if (await $.session.id() !== external_session_id || await $.session.cwd() !== cwd
          || $.plugin?.name !== plugin.name || $.plugin?.root !== plugin.root) {
          throw new ModError('Claude session/project or loaded Mod changed while capturing discovery; refresh the original conversation.');
        }
        if (stopped) return false;
        const announcement = {adapter_id:'claude_code_mod',external_session_id,cwd,host_version,
          plugin,descriptor:{...descriptor},binding_scope};
        const ack = envelope(await $.process.run([descriptor.helperPath,'bridge','announce',
          '--request-id',globalThis.crypto.randomUUID(),'--json-stdin'],
        {stdin:JSON.stringify(announcement),timeoutMs:5000}));
        if (!fields(ack,['adapter_id','external_session_id']) || ack.adapter_id !== announcement.adapter_id
          || ack.external_session_id !== external_session_id) {
          throw new ModError('Discovery acknowledgement differs from the original provider/session identity; check matching app/helper versions.');
        }
        return true;
      } finally { pending = false; }
    },
    // The SDK bounds an already-started helper; stopping admits no later heartbeat.
    stop() { stopped = true; },
  };
}
