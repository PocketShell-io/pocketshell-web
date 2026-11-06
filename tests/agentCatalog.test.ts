import {describe,expect,it} from 'vitest';
import {PocketshellProbe} from '../src/workspace/agentProbe';
import {AgentService} from '../src/platform/agentEnv';
import type {SshConnection} from '../src/terminal/connection';
const rows=[{name:'claude',available:true},{name:'custom-review-engine',available:true},{name:'codex',available:false},{name:'shell',available:true}];
describe('Actual web live engine catalog',()=>{
  it('the support probe uses a engines JSON rather than retired helper help',async()=>{
    const calls:string[]=[];
    const support=await new PocketshellProbe({exec:async command=>{calls.push(command);return{exitCode:0,stdout:JSON.stringify(rows),stderr:'',error:null};}}).agentSupport();
    expect(support.engineIds).toEqual(['claude','custom-review-engine']);
    expect(calls).toHaveLength(1);expect(calls[0]).toContain('a engines --json');
  });
  it('the actual platform kinds service forwards custom available IDs',async()=>{
    const service=new AgentService({exec:async()=>({exitCode:0,stdout:JSON.stringify(rows),stderr:'',error:null})} as unknown as SshConnection);
    expect(await service.kinds()).toEqual(['claude','custom-review-engine']);
  });
});
