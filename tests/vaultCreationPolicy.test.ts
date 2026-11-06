// @vitest-environment jsdom
import{beforeEach,describe,expect,it,vi}from'vitest';
import{mount}from'@vue/test-utils';
import{createPinia,setActivePinia}from'pinia';
import{KeyVaultStore}from'@pocketshell/core';
import{MemoryTransport}from'../../pocketshell-core/tests/keyVault/memoryTransport';
import{isValidNewVaultPassphrase}from'@ui/app/keyVault';
import{useVaultStore}from'../src/stores/vault';
import NewPassphraseFields from'../src/components/NewPassphraseFields.vue';
beforeEach(()=>setActivePinia(createPinia()));
describe('Web new vault passphrase policy',()=>{
  it('shares the normalized twelve-character nonnumeric minimum with the app',()=>{
    for(const p of ['12345678','123456789012','١٢٣٤٥٦٧٨٩٠١٢','①②③④⑤⑥⑦⑧⑨⓪①②','            '])expect(isValidNewVaultPassphrase(p)).toBe(false);
    expect(isValidNewVaultPassphrase('unrelated words here')).toBe(true);
  });
  it('the actual new-passphrase fields reject matching numeric PINs and accept a matching strong phrase',async()=>{
    const wrapper=mount(NewPassphraseFields,{props:{idPrefix:'new'}});
    await wrapper.get('#new-new').setValue('123456789012');await wrapper.get('#new-again').setValue('123456789012');
    expect(wrapper.emitted('update:valid')!.at(-1)).toEqual(['']);expect(wrapper.text()).toContain('not a numeric PIN');
    await wrapper.get('#new-new').setValue('unrelated words here');await wrapper.get('#new-again').setValue('unrelated words here');
    expect(wrapper.emitted('update:valid')!.at(-1)).toEqual(['unrelated words here']);wrapper.unmount();
  });
  it('the web creation action refuses weak input before any network operation',async()=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    try{await expect(useVaultStore().create('123456789012','synthetic sync',false)).rejects.toThrow(/numeric PIN/);expect(fetcher).not.toHaveBeenCalled();}
    finally{vi.unstubAllGlobals();}
  });
  it('already existing weak legacy passphrases still unlock their original encrypted vault',async()=>{
    const store=new KeyVaultStore({transport:new MemoryTransport(),kdf:{m:32768,t:3,p:1}});
    await store.createVault('12345678');store.lock();expect((await store.unlock('12345678')).kind).toBe('ok');
  });
});
