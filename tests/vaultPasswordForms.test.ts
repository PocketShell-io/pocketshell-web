// @vitest-environment jsdom
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {generateKeyPairSync} from 'node:crypto';
import {createPinia,setActivePinia} from 'pinia';
import {createMemoryHistory,createRouter} from 'vue-router';
import {mount} from '@vue/test-utils';
import {provideApi} from '@ui/app/ipc';
import {webApi} from '../src/platform/webApi';
import {KeyVaultStore} from '@pocketshell/core';
import {MemoryTransport} from '../../pocketshell-core/tests/keyVault/memoryTransport';
import {useAuthStore} from '../src/stores/auth';
import {setKeyVaultFactoryForTests,useVaultStore} from '../src/stores/vault';
import {useVaultGateStore} from '../src/stores/vaultGate';
import {useHostsStore} from '../src/stores/hosts';
import {useWarningsStore} from '../src/stores/warnings';
import KeysView from '../src/views/KeysView.vue';
import HostsView from '../src/views/HostsView.vue';
const PASS='synthetic strong vault passphrase';
const pem=()=>String(generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}));
const host=()=>({name:'synthetic-box',hostname:'synthetic.invalid',port:22,user:'tester',identityFile:null,proxyJump:null,forwardAgent:false,localForwards:[],remoteForwards:[],fromConfig:false});
beforeEach(()=>{setActivePinia(createPinia());setKeyVaultFactoryForTests(null);localStorage.clear();sessionStorage.clear();provideApi(webApi);});
async function fixture(){
  useAuthStore().signIn(`e30.${Buffer.from(JSON.stringify({sub:'synthetic:a',email:'synthetic@example.test',exp:4102444800})).toString('base64url')}.x`);
  const transport=new MemoryTransport();Object.assign(transport,{scoped:()=>transport});
  const core=new KeyVaultStore({transport,kdf:{m:32768,t:3,p:1}});await core.createVault(PASS,{syncPassphrase:'synthetic sync passphrase'});
  setKeyVaultFactoryForTests(()=>core);const vault=useVaultStore();vault.core();vault.refresh();
  useVaultGateStore().checked=true;const hosts=useHostsStore();hosts.pulled=true;hosts.passphrase='synthetic sync passphrase';hosts.ownerSub='synthetic:a';
  useWarningsStore().sweep=vi.fn(async()=>undefined);
  const router=createRouter({history:createMemoryHistory(),routes:[{path:'/keys',name:'keys',component:{template:'<div />'}},{path:'/app',name:'app-hosts',component:{template:'<div />'}},{path:'/device/sessions',name:'device-sessions',component:{template:'<div />'}}]});await router.push('/keys');await router.isReady();
  transport.writes.length=0;return{core,vault,hosts,transport,router};
}
vi.setConfig({testTimeout:30000});
describe('Actual web password entry forms',()=>{
  it('Keys shows a distinct masked vault phrase and refuses wrong confirmation before adding',async()=>{
    const{router,core,transport}=await fixture();const wrapper=mount(KeysView,{global:{plugins:[router]}});
    await wrapper.findAll('button').find(b=>b.text()==='Add password')!.trigger('click');
    expect(wrapper.get('#pw-vaultpass').attributes('type')).toBe('password');
    await wrapper.get('#pw-value').setValue('synthetic-server-secret');await wrapper.get('#pw-name').setValue('server');await wrapper.get('#pw-vaultpass').setValue('wrong');
    await wrapper.get('details.keybox form').trigger('submit');
    await vi.waitFor(()=>expect(wrapper.text()).toContain("That passphrase didn't unlock your vault."),{timeout:10000});
    expect(transport.writes).toEqual([]);expect((wrapper.get('#pw-vaultpass').element as HTMLInputElement).value).toBe('');
    await wrapper.get('#pw-vaultpass').setValue(PASS);await wrapper.get('details.keybox form').trigger('submit');
    await vi.waitFor(()=>expect(core.listKeys()).toHaveLength(1),{timeout:10000});wrapper.unmount();
  });
  it('the Hosts credential dialog also requires a fresh masked vault phrase',async()=>{
    const{router,core,hosts}=await fixture();hosts.hosts=[host()];const confirm=vi.spyOn(core,'confirmPassphrase');
    const wrapper=mount(HostsView,{global:{plugins:[router]}});
    await wrapper.findAll('button').find(b=>b.text()==='Key…')!.trigger('click');
    await wrapper.findAll('button[role=tab]').find(b=>b.text()==='Password')!.trigger('click');
    expect(wrapper.get('#kf-pwvault').attributes('type')).toBe('password');
    await wrapper.get('#kf-pw').setValue('synthetic-server-secret');await wrapper.get('#kf-pwvault').setValue(PASS);
    await wrapper.get('form.pw-form').trigger('submit');
    await vi.waitFor(()=>expect(core.listKeys()).toHaveLength(1),{timeout:10000});
    expect(core.getHostBinding('synthetic-box')?.keyId).toBe(core.listKeys()[0].keyId);expect(confirm).toHaveBeenCalledTimes(1);wrapper.unmount();
  });
  it('assigning an existing vault key asks once and refuses the wrong phrase before granting access',async()=>{
    const{router,core,hosts,transport,vault}=await fixture();hosts.hosts=[host()];
    const key=await core.addKey(pem(),'existing');if(key.kind!=='ok')throw new Error('fixture');vault.refresh();transport.writes.length=0;
    const wrapper=mount(HostsView,{global:{plugins:[router]}});
    await wrapper.findAll('button').find(b=>b.text()==='Key…')!.trigger('click');
    await wrapper.get('#kf-entry').setValue(key.entry.keyId);
    expect(wrapper.get('#kf-vaultpass-existing').attributes('type')).toBe('password');
    await wrapper.get('#kf-vaultpass-existing').setValue('wrong');await wrapper.get('form.pick-form').trigger('submit');
    await vi.waitFor(()=>expect(wrapper.text()).toContain("That passphrase didn't unlock your vault."),{timeout:10000});
    expect(core.getHostBinding('synthetic-box')).toBeNull();expect(transport.writes).toEqual([]);
    await wrapper.get('#kf-vaultpass-existing').setValue(PASS);await wrapper.get('form.pick-form').trigger('submit');
    await vi.waitFor(()=>expect(core.getHostBinding('synthetic-box')?.keyId).toBe(key.entry.keyId),{timeout:10000});wrapper.unmount();
  });
  it('saving a changed host destination with an existing vault credential requires fresh confirmation',async()=>{
    const{router,core,hosts,vault}=await fixture();hosts.hosts=[host()];
    const key=await core.addKey(pem(),'existing');if(key.kind!=='ok')throw new Error('fixture');await core.bindHost('synthetic-box',key.entry.keyId,'managed');vault.refresh();
    const save=vi.spyOn(hosts,'saveHost').mockResolvedValue(undefined);
    const wrapper=mount(HostsView,{global:{plugins:[router]}});
    await wrapper.findAll('button').find(b=>b.text()==='Edit')!.trigger('click');
    expect(wrapper.get('#hf-vaultpass').attributes('type')).toBe('password');
    await wrapper.get('#hf-host').setValue('new-synthetic.invalid');await wrapper.get('#hf-vaultpass').setValue('wrong');await wrapper.get('form.hostform').trigger('submit');
    await vi.waitFor(()=>expect(wrapper.text()).toContain("That passphrase didn't unlock your vault."),{timeout:10000});expect(save).not.toHaveBeenCalled();
    await wrapper.get('#hf-vaultpass').setValue(PASS);await wrapper.get('form.hostform').trigger('submit');
    await vi.waitFor(()=>expect(save).toHaveBeenCalledTimes(1),{timeout:10000});expect(save.mock.calls[0][0].hostname).toBe('new-synthetic.invalid');wrapper.unmount();
  });
});
