import { describe, it, expect } from 'vitest';
import { bytes, clip, descriptorValid, envelope, hash, lifecycle, prepared, reportReceipt } from '../../../integrations/claude/plugin/hooks/contracts.js';

const binding = { binding_id:'11111111-1111-4111-8111-111111111111', generation:'22222222-2222-4222-8222-222222222222' };
const input = '33333333-3333-4333-8333-333333333333';
const attempt = '44444444-4444-4444-8444-444444444444';
function result(data) { return {exitCode:0,stdout:JSON.stringify({api_version:1,ok:true,data})}; }
async function claim() {
  const wire_marker = `[ARIADNE_INPUT:${input}:${attempt}]`;
  const formatted_payload = wire_marker + '\n' + JSON.stringify({owner_text:'exact\n😀',binding_id:binding.binding_id,generation:binding.generation});
  return {input_id:input,attempt_id:attempt,binding_generation:binding.generation,wire_marker,formatted_payload,payload_sha256:await hash(formatted_payload)};
}
describe('published wire consumers', () => {
  it('requires installed immutable descriptor and exact version/API without path fallback', () => {
    const descriptor = {helperPath:'/home/owner/.local/share/ariadne/current/bin/ariadne',appVersion:'0.1.0',apiVersion:1};
    expect(descriptorValid(descriptor,'0.1.0')).toBe(true);
    for (const value of [null,{...descriptor,helperPath:'ariadne'},{...descriptor,helperPath:'/app/../ariadne'},{...descriptor,apiVersion:2},{...descriptor,appVersion:'0.2.0'},{...descriptor,extra:true}]) {
      expect(descriptorValid(value,'0.1.0')).toBe(false);
    }
  });
  it('requires complete bounded success envelopes and never interprets CLI text as success', () => {
    expect(envelope(result(null))).toBe(null);
    for (const value of [{stdout:'not JSON',exitCode:0},{...result(null),isStdoutTruncated:true},{...result(null),isStderrTruncated:true},{...result(null),exitCode:1},result('x'.repeat(1024*1024)),{stdout:'{"api_version":2,"ok":true,"data":null}',exitCode:0}]) {
      expect(() => envelope(value)).toThrow();
    }
  });
  it('rejects malformed canonical errors and never suggests a retry/new identity for uncertainty', () => {
    const error = {code:'delivery_uncertain',message:'Possible send',hint:'Retain original ID',retryable:false,field_errors:[]};
    const failed = error => ({exitCode:6,stdout:JSON.stringify({api_version:1,ok:false,error})});
    expect(() => envelope(failed(error))).toThrow('delivery_uncertain');
    for (const invalid of [{...error,retryable:true},{...error,message:' '},{...error,hint:'x'.repeat(4097)},{...error,field_errors:[{field:'',message:'bad'}]}, {...error,unexpected:'raw'}]) {
      expect(() => envelope(failed(invalid))).toThrow('invalid error');
    }
  });
  it('validates exact marker, full UTF8 bytes and original generation with no reconstruction', async () => {
    const value = await claim();
    expect(await prepared(value,binding)).toBe(value);
    for (const invalid of [{...value,formatted_payload:value.formatted_payload+' '},{...value,wire_marker:'[ARIADNE_INPUT:marker]'},{...value,binding_generation:binding.binding_id},{...value,input_id:'notUUID'},{...value,formatted_payload:'prefix\n'+value.formatted_payload},{...value,extra:true}]) {
      await expect(prepared(invalid,binding)).rejects.toThrow();
    }
  });
  it('matches canonical terminal compact-JSON fallback and stable accepted facts', async () => {
    const value = await claim();
    const terminal = await lifecycle(binding,value,'turn_finished',{status:'completed',reason:null,diagnostic_text:null,truncated:false},'actual-turn');
    expect(terminal.event_id).toBe(await hash(JSON.stringify([binding.binding_id,binding.generation,attempt,'actual-turn','turn_finished'])));
    const first = await lifecycle(binding,value,'accepted',{receipt:null},'actual-turn');
    const again = await lifecycle(binding,value,'accepted',{receipt:null},'actual-turn');
    expect(first.event_id).toBe(again.event_id);
    expect((await lifecycle({...binding,generation:binding.binding_id},value,'accepted',{receipt:null},'actual-turn')).event_id).not.toBe(first.event_id);
  });
  it('accepts matching changed or unchanged Core receipts and rejects malformed or mismatched acknowledgments', async () => {
    const event = await lifecycle(binding,await claim(),'accepted',{receipt:null});
    const session = {session_id:input};
    const receipt = {event_id:event.event_id,session_id:input,revision:1,durable_effect:true,replayed:false};
    expect(reportReceipt(receipt,event,session)).toBe(receipt);
    for (const value of [{...receipt,durable_effect:false,revision:null},{...receipt,durable_effect:false}, {...receipt,replayed:true}]) {
      expect(reportReceipt(value,event,session)).toBe(value);
    }
    for (const value of [{...receipt,event_id:'other'},{...receipt,session_id:attempt},{...receipt,revision:null},{...receipt,durable_effect:'false'},{...receipt,replayed:'yes'}, {...receipt,revision:0}, {...receipt,revision:1.5}, {...receipt,revision:Number.MAX_SAFE_INTEGER+1}, {...receipt,revision:'1'}]) {
      expect(() => reportReceipt(value,event,session)).toThrow();
    }
  });
  it('bounds diagnostics by UTF8 bytes without splitting Unicode or altering short exact text', () => {
    expect(clip(' exact\n')).toEqual({text:' exact\n',truncated:false});
    expect(clip('😀😀😀',9)).toEqual({text:'😀😀',truncated:true});
    expect(bytes(clip('😀'.repeat(20000)).text)).toBe(65536);
    expect(clip(undefined)).toEqual({text:'',truncated:false});
  });
});
