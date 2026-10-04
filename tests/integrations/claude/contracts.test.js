import { describe, it, expect, vi } from 'vitest';
import { claimLoop } from '../../../integrations/claude/plugin/hooks/claims.js';
import { binding as fixtureBinding, host, ids, prepared as fixturePrepared } from './fixtures.js';
import modEvents from '../../../fixtures/providers/claude/mod-events.json';
import { bytes, claudeSessionEndEventId, clip, descriptorValid, envelope, hash, lifecycle, prepared, reportReceipt } from '../../../integrations/claude/plugin/hooks/contracts.js';

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
  it('uses the reserved Rust identity for the exact saved session-end scope', () => {
    expect(claudeSessionEndEventId(binding.binding_id,binding.generation)).toBe(`claude:session-ended:${binding.binding_id}:${binding.generation}`);
    for (const value of ['',null,'not-a-uuid']) {
      expect(() => claudeSessionEndEventId(value,binding.generation)).toThrow();
      expect(() => claudeSessionEndEventId(binding.binding_id,value)).toThrow();
    }
  });
  it('requires immutable descriptor and actual SDK loaded plugin identity without path fallback', () => {
    const descriptor = {helperPath:'/home/owner/.local/share/ariadne/current/bin/ariadne',appVersion:'0.1.0',apiVersion:1};
    const plugin = {name:'ariadne',root:'/sdk-reported/plugin'};
    expect(descriptorValid(descriptor,plugin)).toBe(true);
    for (const value of [null,{...descriptor,helperPath:'ariadne'},{...descriptor,helperPath:'/app/../ariadne'},{...descriptor,apiVersion:2},{...descriptor,appVersion:''},{...descriptor,extra:true}]) {
      expect(descriptorValid(value,plugin)).toBe(false);
    }
    for (const value of [{version:'0.1.0'},{...plugin,name:'other'},{...plugin,root:'relative'},{...plugin,root:'/app/../plugin'}, {...plugin,version:'0.1.0'}]) {
      expect(descriptorValid(descriptor,value)).toBe(false);
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
  it('emits canonical ISO timestamps and source-backed lifecycle fixtures including session end', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T00:00:00.123Z'));
    const identity = vi.spyOn(globalThis.crypto,'randomUUID').mockReturnValue('77777777-7777-4777-8777-777777777777');
    try {
      const claim = await fixturePrepared();
      const events = [];
      for (const [kind,payload,turn] of [
        ['accepted',{receipt:null},null],
        ['accepted',{receipt:{provider_reference:'fixture-provider-reference',observed_at:'2026-10-03T23:59:59.999Z'}},'actual-turn'],
        ['turn_started',{},'actual-turn'],
        ['turn_finished',{status:'completed',reason:'answer',diagnostic_text:'Exact visible answer 😀',truncated:false},'actual-turn'],
        ['turn_finished',{status:'interrupted',reason:'aborted',diagnostic_text:null,truncated:false},'actual-turn'],
        ['turn_finished',{status:'failed',reason:'error',diagnostic_text:'Visible failure',truncated:false},'actual-turn'],
        ['rejected',{reason:'Claude prompt submission was dropped before matching turn evidence.'},null],
        ['uncertain',{reason:'Prompt submission failed with unknown delivery; reconcile the original attempt.'},null],
      ]) events.push(await lifecycle(fixtureBinding,claim,kind,payload,turn));
      const fixture = host();
      await claimLoop('/installed/helper',fixtureBinding).stop(fixture.$,true);
      events.push(...fixture.events);
      expect(events).toEqual(modEvents);
      expect(events.every(event => event.observed_at === '2026-10-04T00:00:00.123Z')).toBe(true);
      expect(events.at(-1).kind).toBe('disconnected');
      expect(events.at(-1).input_id).toBe(null);
      expect(events.at(-1).attempt_id).toBe(null);
      expect(ids.binding).toBe(events[0].binding_id);
    } finally { identity.mockRestore(); vi.useRealTimers(); }
  });
  it('bounds diagnostics by UTF8 bytes without splitting Unicode or altering short exact text', () => {
    expect(clip(' exact\n')).toEqual({text:' exact\n',truncated:false});
    expect(clip('😀😀😀',9)).toEqual({text:'😀😀',truncated:true});
    expect(bytes(clip('😀'.repeat(20000)).text)).toBe(65536);
    expect(clip(undefined)).toEqual({text:'',truncated:false});
  });
});
