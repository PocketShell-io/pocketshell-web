// @vitest-environment jsdom
import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { KeyVaultStore } from '@pocketshell/core';
import { MemoryTransport } from '../../pocketshell-core/tests/keyVault/memoryTransport';
import { useAuthStore } from '../src/stores/auth';
import { setKeyVaultFactoryForTests, useVaultStore } from '../src/stores/vault';
import KeyUploadForm from '../src/components/KeyUploadForm.vue';

const PASS='synthetic strong vault passphrase';
const KDF={m:32768,t:3,p:1};
const pem=()=>String(generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}));
function jwt(sub:string){return `e30.${Buffer.from(JSON.stringify({sub,email:'synthetic@example.test',exp:4102444800})).toString('base64url')}.x`;}
beforeEach(()=>{setActivePinia(createPinia());setKeyVaultFactoryForTests(null);localStorage.clear();sessionStorage.clear();});
async function fixture(){
  useAuthStore().signIn(jwt('synthetic:a'));
  const transport=new MemoryTransport();Object.assign(transport,{scoped:()=>transport});
  const core=new KeyVaultStore({transport,kdf:KDF});await core.createVault(PASS);
  setKeyVaultFactoryForTests(()=>core);
  const vault=useVaultStore();vault.core();vault.refresh();transport.writes.length=0;
  return{core,vault,transport};
}
vi.setConfig({testTimeout:30000});
describe('Actual web vault additions',()=>{
  it('an unlocked web vault still requires an explicitly entered phrase before adding a key',async()=>{
    const{vault,core,transport}=await fixture();
    expect((await vault.addKey(pem(),'new')).kind).not.toBe('ok');
    expect(transport.writes).toEqual([]);expect(core.listKeys()).toEqual([]);
  });
  it('the web action rejects a wrong vault phrase before any encrypted upload',async()=>{
    const{vault,core,transport}=await fixture();
    expect((await vault.addKey(pem(),'new',undefined,'wrong vault phrase')).kind).not.toBe('ok');
    expect(transport.writes).toEqual([]);expect(core.listKeys()).toEqual([]);
  });
  it('the actual web upload form asks for a masked vault phrase',async()=>{
    await fixture();const wrapper=mount(KeyUploadForm,{props:{idPrefix:'upload'}});
    expect(wrapper.get('#upload-vaultpass').attributes('type')).toBe('password');wrapper.unmount();
  });
  it('one correct entry authorizes one upload, never the next one',async()=>{
    const{vault,core,transport}=await fixture();
    expect((await vault.addKey(pem(),'first',undefined,PASS)).kind).toBe('ok');
    const writes=transport.writes.length;
    expect((await vault.addKey(pem(),'second')).kind).not.toBe('ok');
    expect(transport.writes).toHaveLength(writes);expect(core.listKeys()).toHaveLength(1);
  });
  it('the actual web form rejects wrong then accepts correct and clears each phrase entry',async()=>{
    const{core,transport}=await fixture();const wrapper=mount(KeyUploadForm,{props:{idPrefix:'upload'}});
    await wrapper.get('#upload-pem').setValue(pem());await wrapper.get('#upload-vaultpass').setValue('wrong');
    await wrapper.get('form').trigger('submit');
    await vi.waitFor(()=>expect(wrapper.text()).toContain("That passphrase didn't unlock your vault."),{timeout:10000});
    expect(transport.writes).toEqual([]);expect((wrapper.get('#upload-vaultpass').element as HTMLInputElement).value).toBe('');
    await wrapper.get('#upload-vaultpass').setValue(PASS);await wrapper.get('form').trigger('submit');
    await vi.waitFor(()=>expect(wrapper.emitted('added')).toHaveLength(1),{timeout:10000});
    expect(core.listKeys()).toHaveLength(1);expect((wrapper.get('#upload-vaultpass').element as HTMLInputElement).value).toBe('');wrapper.unmount();
  });
  it('cancel while a bound verification read waits prevents writes and success events',async()=>{
    const{core,transport}=await fixture();const read=transport.pull.bind(transport);
    let release! :()=>void;let entered! :()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
    transport.pull=async slot=>{entered();await new Promise<void>(resolve=>{release=resolve;});return read(slot);};
    const wrapper=mount(KeyUploadForm,{props:{idPrefix:'upload'}});
    await wrapper.get('#upload-pem').setValue(pem());await wrapper.get('#upload-vaultpass').setValue(PASS);
    await wrapper.get('form').trigger('submit');await waiting;await wrapper.get('button[type=button]').trigger('click');release();
    await vi.waitFor(()=>expect(wrapper.get('button[type=submit]').text()).toBe('Add to vault'),{timeout:10000});
    expect(wrapper.emitted('cancel')).toHaveLength(1);expect(wrapper.emitted('added')).toBeUndefined();
    expect(transport.writes).toEqual([]);expect(core.listKeys()).toEqual([]);wrapper.unmount();
  });
  it('changing Google subject while verification waits refuses the old operation',async()=>{
    const{vault,core,transport}=await fixture();const read=transport.pull.bind(transport);
    let release! :()=>void;let entered! :()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
    transport.pull=async slot=>{entered();await new Promise<void>(resolve=>{release=resolve;});return read(slot);};
    const pending=vault.addKey(pem(),'old account',undefined,PASS);await waiting;
    useAuthStore().signIn(jwt('synthetic:b'));release();
    expect((await pending).kind).not.toBe('ok');expect(transport.writes).toEqual([]);expect(core.listKeys()).toEqual([]);
  });
  it('a remembered unlock still needs a new vault phrase to add credentials',async()=>{
    const{vault,core,transport}=await fixture();const record=core.exportRememberRecord()!;
    vault.lock();await core.unlockWithRememberedDek(record);
    expect((await vault.addKey(pem(),'remembered')).kind).not.toBe('ok');expect(transport.writes).toEqual([]);
    expect((await vault.addKey(pem(),'remembered',undefined,PASS)).kind).toBe('ok');record.dek.fill(0);record.auth?.fill(0);
  });
  it('password and rotation actions require fresh validation too',async()=>{
    const{vault,core,transport}=await fixture();
    await expect(vault.addPassword('synthetic-server-secret','password')).rejects.toThrow(/vault passphrase/i);
    await expect(vault.addPassword('synthetic-server-secret','password','wrong')).rejects.toThrow(/passphrase/i);
    expect(transport.writes).toEqual([]);
    expect((await vault.addPassword('synthetic-server-secret','password',PASS)).type).toBe('password');
    const first=await vault.addKey(pem(),'first',undefined,PASS);if(first.kind!=='ok')throw new Error('fixture');
    transport.writes.length=0;
    expect((await vault.rotateKey(first.entry.keyId,pem(),'next',undefined,'wrong')).kind).not.toBe('ok');expect(transport.writes).toEqual([]);
    expect((await vault.rotateKey(first.entry.keyId,pem(),'next',undefined,PASS)).kind).toBe('ok');
    expect(core.getKey(first.entry.keyId)).toBeNull();
    expect(JSON.stringify([...transport.slots.values()])).not.toContain('synthetic-server-secret');
  });
  it('the host-dialog upload commits key and binding after one fresh confirmation',async()=>{
    const{core,transport}=await fixture();const confirm=vi.spyOn(core,'confirmPassphrase');
    const wrapper=mount(KeyUploadForm,{props:{idPrefix:'host',bindHost:{hostAlias:'new-host',gatewayAuth:'managed'}}});
    await wrapper.get('#host-pem').setValue(pem());await wrapper.get('#host-vaultpass').setValue(PASS);await wrapper.get('form').trigger('submit');
    await vi.waitFor(()=>expect(wrapper.emitted('added')).toHaveLength(1),{timeout:10000});
    expect(confirm).toHaveBeenCalledTimes(1);expect(transport.writes.filter(s=>s==='vault')).toHaveLength(1);
    expect(core.getHostBinding('new-host')?.keyId).toBe(core.listKeys()[0].keyId);wrapper.unmount();
  });
  it('an encrypted key file asks for its own phrase before the single vault confirmation',async()=>{
    const{core}=await fixture();const confirm=vi.spyOn(core,'confirmPassphrase');
    const encrypted=String(generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem',cipher:'aes-256-cbc',passphrase:'synthetic key passphrase'}));
    const wrapper=mount(KeyUploadForm,{props:{idPrefix:'upload'}});const file=wrapper.get('#upload-file');
    Object.defineProperty(file.element,'files',{configurable:true,value:[{name:'synthetic.key',text:async()=>encrypted}]});await file.trigger('change');
    await vi.waitFor(()=>expect(wrapper.find('#upload-kpass').exists()).toBe(true));expect(confirm).not.toHaveBeenCalled();
    await wrapper.get('#upload-kpass').setValue('synthetic key passphrase');await wrapper.get('#upload-vaultpass').setValue(PASS);await wrapper.get('form').trigger('submit');
    await vi.waitFor(()=>expect(wrapper.emitted('added')).toHaveLength(1),{timeout:10000});expect(confirm).toHaveBeenCalledTimes(1);wrapper.unmount();
  });
});
