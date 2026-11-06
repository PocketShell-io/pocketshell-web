// @vitest-environment jsdom
import {describe,expect,it} from 'vitest';
import {KeyVaultStore,parseVaultHeader} from '@pocketshell/core';
import {SyncService} from '../src/api/sync';
import {makeVaultTransport} from '../src/vault/webTransport';
import {makeServerVerifier} from '../src/vault/serverVerifier';
const PASS='synthetic strong setup passphrase';
function setup(statusAvailable=true){
  let header:string|null=null;let auth:string|null=null;let initializations=0;let splitWrites=0;let epoch=2;
  const bodies:unknown[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const path=new URL(String(input),'https://synthetic.invalid').pathname;
    const body=init?.body?JSON.parse(String(init.body)):{};
    const reply=(status:number,data:unknown)=>new Response(JSON.stringify(data),{status});
    if(path==='/vault/status')return statusAvailable?reply(200,{epoch,hasVerifier:auth!==null,retryAfter:0}):reply(503,{});
    if(path==='/settings/vault' && init?.method==='GET')return header===null?reply(404,{}):reply(200,{version:1,data:header});
    if(path==='/settings/vault' && init?.method==='PUT'){splitWrites++;header=body.data;return reply(200,{version:1});}
    if(path==='/vault/verifier')return reply(503,{});
    if(path==='/vault/initialize'){
      initializations++;bodies.push(body);
      if(header!==null || auth!==null || body.epoch!==epoch)return reply(409,{error:'conflict'});
      header=body.data;auth=body.auth;return reply(201,{ok:true,version:1,epoch});
    }
    return reply(404,{});
  };
  const sync=new SyncService({auth:{getIdToken:()=> 'synthetic-token'},baseUrl:'https://synthetic.invalid',fetchFn:fetcher});
  const make=()=>new KeyVaultStore({transport:makeVaultTransport(()=>sync),verifier:makeServerVerifier(()=> 'synthetic-token',fetcher),kdf:{m:32768,t:3,p:1}});
  return{make,bodies,header:()=>header,initializations:()=>initializations,splitWrites:()=>splitWrites,setEpoch:(next:number)=>{epoch=next;}};
}
describe('Actual web atomic vault setup',()=>{
  it('creates with the current server epoch in one initialize call, without a partial settings write',async()=>{
    const s=setup();expect((await s.make().createVault(PASS)).kind).toBe('ok');
    expect(parseVaultHeader(s.header()!)?.epoch).toBe(2);
    expect(s.initializations()).toBe(1);expect(s.splitWrites()).toBe(0);
    expect(JSON.stringify(s.bodies)).not.toContain(PASS);
  });
  it('an unavailable server epoch never creates a header through the old split-write path',async()=>{
    const s=setup(false);expect((await s.make().createVault(PASS)).kind).toBe('error');
    expect(s.header()).toBeNull();expect(s.splitWrites()).toBe(0);expect(s.initializations()).toBe(0);
  });
  it('never overwrites a vault created by another client and checks wrong phrases cryptographically',async()=>{
    const s=setup();await s.make().createVault(PASS);const saved=s.header();
    expect((await s.make().createVault('another strong setup passphrase')).kind).toBe('exists');
    expect(s.header()).toBe(saved);expect(s.initializations()).toBe(1);
    const reader=s.make();expect((await reader.unlock('wrong phrase')).kind).toBe('wrongPassphrase');
    expect((await reader.unlock(PASS)).kind).toBe('ok');expect(s.header()).toBe(saved);
  });
  it('concurrent first setups have exactly one atomic winner',async()=>{
    const s=setup();const results=await Promise.all([s.make().createVault(PASS),s.make().createVault('another strong setup passphrase')]);
    expect(results.filter(r=>r.kind==='ok')).toHaveLength(1);
    expect(results.filter(r=>r.kind==='exists')).toHaveLength(1);expect(s.splitWrites()).toBe(0);
    expect(parseVaultHeader(s.header()!)?.epoch).toBe(2);
  });
  it('malformed server status cannot masquerade as an empty vault',async()=>{
    for(const body of [{epoch:2,hasVerifier:'false'},{epoch:0,hasVerifier:false},{epoch:2,hasVerifier:false,kdf:{alg:'invalid'}}]){
      const verifier=makeServerVerifier(()=> 'synthetic-token',async()=>new Response(JSON.stringify(body),{status:200}));
      expect((await verifier.status!()).kind).toBe('unavailable');
    }
  });
  it('initialization refuses stale epoch conflicts without any partial write',async()=>{
    let calls=0;
    const verifier=makeServerVerifier(()=> 'synthetic-token',async(input)=>{
      const path=new URL(String(input),'https://synthetic.invalid').pathname;
      if(path==='/vault/status')return new Response('{"epoch":7,"hasVerifier":false}',{status:200});
      calls++;return new Response('{"error":"epoch_mismatch","epoch":8}',{status:409});
    });
    const transport={scoped(){return this;},pull:async()=>({kind:'absent' as const}),push:async()=>{throw new Error('split write must never run');},delete:async()=>undefined,list:async()=>[]};
    const store=new KeyVaultStore({transport,verifier,kdf:{m:32768,t:3,p:1}});
    expect((await store.createVault(PASS)).kind).toBe('exists');expect(store.state).toBe('locked');expect(calls).toBe(1);
  });
});
