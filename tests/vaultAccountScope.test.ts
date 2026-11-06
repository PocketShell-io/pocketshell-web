// @vitest-environment jsdom
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createPinia,setActivePinia} from 'pinia';
import {SyncService} from '../src/api/sync';
import {makeVaultTransport} from '../src/vault/webTransport';
import {makeServerVerifier} from '../src/vault/serverVerifier';
import {useAuthStore} from '../src/stores/auth';
import {setKeyVaultFactoryForTests,useVaultStore} from '../src/stores/vault';
function jwt(sub:string){return `e30.${Buffer.from(JSON.stringify({sub,email:'synthetic@example.test',exp:4102444800})).toString('base64url')}.x`;}
beforeEach(()=>{setActivePinia(createPinia());setKeyVaultFactoryForTests(null);localStorage.clear();sessionStorage.clear();});
describe('Web account-bound vault IO',()=>{
  it('keeps one opaque account namespace across snapshots and separates independent owners',()=>{
    const service=new SyncService({auth:{getIdToken:()=>jwt('a')},baseUrl:'https://synthetic.invalid'});
    const owner=makeVaultTransport(()=>service);
    const first=owner.scoped!();const second=owner.scoped!();
    expect(owner.scope).toBeDefined();expect(first.scope).toBe(owner.scope);expect(second.scope).toBe(owner.scope);
    expect(first.scoped!().scope).toBe(owner.scope);
    expect(makeVaultTransport(()=>service).scope).not.toBe(owner.scope);
  });
  it('a scoped slot transport keeps its original service instead of following a changed selector',async()=>{
    const calls:string[]=[];
    const service=(token:string)=>new SyncService({auth:{getIdToken:()=>token},baseUrl:'https://synthetic.invalid',fetchFn:async(_url,init)=>{calls.push((init!.headers as Record<string,string>).Authorization);return new Response('{"version":1}',{status:200});}});
    let selected=service(jwt('a'));const transport=makeVaultTransport(()=>selected).scoped!();selected=service(jwt('b'));
    expect((await transport.push('vault','synthetic ciphertext',0)).kind).toBe('ok');expect(calls).toEqual([`Bearer ${jwt('a')}`]);
  });
  it('a scoped verifier keeps its token and never obtains the new account token',async()=>{
    const calls:string[]=[];let selected=jwt('a');
    const verifier=makeServerVerifier(()=>selected,async(_url,init)=>{calls.push((init!.headers as Record<string,string>).Authorization);return new Response('{"ok":true}',{status:200});}).scoped!();
    selected=jwt('b');expect((await verifier.verify(new Uint8Array(32).fill(7))).kind).toBe('ok');expect(calls).toEqual([`Bearer ${jwt('a')}`]);
  });
  it('the actual web store cannot redirect an old account request onto a new subject',async()=>{
    const fetcher=vi.fn(async()=>new Response('{"message":"not found"}',{status:404}));vi.stubGlobal('fetch',fetcher);
    try{
      useAuthStore().signIn(jwt('a'));const old=useVaultStore().core();useAuthStore().signIn(jwt('b'));
      expect((await old.probe()).kind).toBe('error');
      await expect((async()=>old.addPassword('synthetic-secret','must refuse'))()).rejects.toThrow(/account changed/i);
      expect(fetcher).not.toHaveBeenCalled();
    }finally{vi.unstubAllGlobals();}
  });
});
