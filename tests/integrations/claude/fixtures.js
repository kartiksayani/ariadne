import { hash } from '../../../integrations/claude/plugin/hooks/contracts.js';
export const ids = Object.freeze({project:'11111111-1111-4111-8111-111111111111',session:'22222222-2222-4222-8222-222222222222',
  binding:'33333333-3333-4333-8333-333333333333',generation:'44444444-4444-4444-8444-444444444444',
  input:'55555555-5555-4555-8555-555555555555',attempt:'66666666-6666-4666-8666-666666666666'});
export const descriptor = Object.freeze({helperPath:'/installed/ariadne/current/bin/ariadne',appVersion:'0.1.0',apiVersion:1});
export const binding = Object.freeze({binding_id:ids.binding,generation:ids.generation,external_session_id:'original-host-session',
  session:Object.freeze({project_id:ids.project,session_id:ids.session})});
export const status = Object.freeze({id:ids.binding,generation:ids.generation,adapter_id:'claude_code_mod',external_session_id:binding.external_session_id,
  dispatch_state:'enabled',owner_paused:false,pause_reason:null,connection_state:'connected',presence:null});
export function success(data) { return {exitCode:0,stdout:JSON.stringify({api_version:1,ok:true,data}),stderr:''}; }
export function failure(code = 'host_unreachable') {
  return {exitCode:4,stdout:JSON.stringify({api_version:1,ok:false,error:{code,message:'Fixture failure',hint:'Retain original IDs',retryable:false,field_errors:[]}}),stderr:''};
}
export function capabilities() {
  return {...Object.fromEntries(['existing_session','deferred_delivery','turn_correlation','turn_completion','domain_cli','domain_mcp','history_reconcile','streaming_output','final_text_read','discover_sessions'].map(name => [name,{supported:true,conditions:[]}])),delivery_mode:'pull'};
}
export async function prepared() {
  const wire_marker = `[ARIADNE_INPUT:${ids.input}:${ids.attempt}]`;
  const formatted_payload = `${wire_marker}\n` + JSON.stringify({binding_id:ids.binding,generation:ids.generation,owner_text:'Exact user text\n😀 $(no shell)'});
  return {input_id:ids.input,attempt_id:ids.attempt,binding_generation:ids.generation,wire_marker,formatted_payload,payload_sha256:await hash(formatted_payload)};
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes,no) => {resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
// Transport/SDK seam only: canned claim/owner replies and canonical event receipts.
// No eligibility, mutation, history, persistence or join state machine.
export function host({claim = null, submit = () => Promise.resolve({text:claim.formatted_payload}), handler = null, version = '2.1.287'} = {}) {
  const calls = [], events = [], prompts = [], logs = [], commands = [];
  const waiters = [];
  let timer = null;
  const timers = [];
  let external = binding.external_session_id;
  const $ = {
    plugin:{name:'ariadne',root:'/sdk-reported/plugin'},session:{id:async () => external,cwd:async () => '/project/original',version:async () => ({version})},
    ui:{log:text => logs.push(text)},command:{register:async spec => {commands.push(spec);}},
    clock:{every:(ms,callback) => {timer={ms,callback,cancelled:false,cancel(){this.cancelled=true;}};timers.push(timer);return timer;}},
    prompt:{submit:args => {prompts.push(args);return submit(args);}},
    process:{run:async (argv,options) => {
      calls.push({argv,options});
      if (handler) {const response = await handler(argv,options);if (response !== undefined) return response;}
      if (argv[1] === '--version') return {exitCode:0,stdout:'ariadne 0.1.0\n',stderr:''};
      if (argv[1] === 'project') {
        const request = JSON.parse(options.stdin);
        return success({operation_id:request.command.op_id,project_id:ids.project,registry_revision:1});
      }
      if (argv[1] === 'binding') {
        const request = JSON.parse(options.stdin);
        return success({operation_id:request.command.op_id,session_id:ids.session,revision:2,data:argv[2] === 'connect'
          ? {kind:'binding_connect',binding_id:ids.binding,generation:ids.generation,capabilities:capabilities(),setup_instruction:'Use published Ariadne domain commands.'}
          : {kind:'binding_state',binding_id:ids.binding,generation:ids.generation,dispatch_state:'disconnected',owner_paused:false,pause_reason:null,connection_state:'disconnected'}});
      }
      if (argv[2] === 'connection-status') return success(status);
      if (argv[2] === 'announce') {
        const body = JSON.parse(options.stdin);
        return success({adapter_id:body.adapter_id,external_session_id:body.external_session_id});
      }
      if (argv[2] === 'claim') return success(claim);
      if (argv[2] === 'report') {
        const event = JSON.parse(options.stdin);events.push(event);
        for (const waiter of waiters) if (waiter.kind === event.kind) waiter.resolve(event);
        return success({event_id:event.event_id,session_id:ids.session,revision:3,durable_effect:true,replayed:false});
      }
      throw new Error('Unexpected fixture helper argv');
    }},
  };
  return {$,calls,events,prompts,logs,commands,timer:() => timers.find(timer => timer.ms === 1000) ?? null,timers:() => timers,switchSession:value => {external=value;},
    reported:kind => events.find(event => event.kind === kind) ? Promise.resolve(events.find(event => event.kind === kind))
      : new Promise(resolve => waiters.push({kind,resolve}))};
}
