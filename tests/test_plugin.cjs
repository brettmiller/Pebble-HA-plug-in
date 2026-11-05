const assert=require('assert');
const fs=require('fs'),vm=require('vm'),path=require('path');
const root=path.resolve(__dirname,'..');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).pebble;
assert.strictEqual(pkg.projectType,'plugin');
assert.strictEqual(pkg.manifestVersion,2);
assert(pkg.plugin.sources.length>0);
assert(pkg.plugin.sources.every(source=>source.category==='agent'),
  'All sources must use the Pebble Store-supported agent category');
assert(pkg.plugin.sources.some(source=>source.items.includes('entity')));
assert(pkg.plugin.sources.some(source=>source.items.includes('configured')));
assert(pkg.plugin.actions.find(a=>a.name==='call_service').callerPermissions.includes('HomeControl'));
assert(pkg.plugin.actions.find(a=>a.name==='conversation').callerPermissions.includes('HomeConverse'));
assert(pkg.plugin.actions.find(a=>a.name==='get_config').callerPermissions.includes('HomeRead'));
assert(pkg.plugin.sources.find(s=>s.items.includes('entity')).callerPermissions.includes('HomeRead'));
let config,source,action,stored={},local={},calls=[];
const secure={
  getItem:async k=>stored[k]||null,
  setItem:async(k,v)=>{stored[k]=v;},
  removeItem:async k=>{delete stored[k];}
};
const Pebble={secureStorage:secure,refreshSources:()=>{},
  registerConfigHandler:fn=>config=fn,
  registerSourceHandler:fn=>source=fn,
  registerActionHandler:fn=>action=fn};
class MockWebSocket {
  constructor(url) {
    assert.strictEqual(url,'wss://ha.example.com/api/websocket');
    this.send=(raw)=>{
      const message=JSON.parse(raw);
      if(message.type==='auth') {
        assert.strictEqual(message.access_token,'secret');
        this.onmessage({data:JSON.stringify({type:'auth_ok'})});
      } else {
        let result=message.type==='assist_pipeline/pipeline/list'?
          {preferred_pipeline:'pipeline-1',pipelines:[{
            id:'pipeline-1',name:'Default Assist',
            stt_engine:'stt.mock',tts_engine:'tts.mock',
            conversation_engine:'conversation.google_ai'
          }]}:
          {agents:[{id:'conversation.google_ai',name:'Google AI'}]};
        this.onmessage({data:JSON.stringify({id:1,type:'result',success:true,result})});
      }
    };
    this.close=()=>{};
    Promise.resolve().then(()=>this.onmessage({data:JSON.stringify({type:'auth_required'})}));
  }
}
const context={Pebble,console,Date,JSON,Number,String,Object,Array,Promise,isFinite,WebSocket:MockWebSocket,
  setTimeout:()=>1,clearTimeout:()=>{},
  localStorage:{getItem:k=>local[k]||null,setItem:(k,v)=>local[k]=v,removeItem:k=>delete local[k]},
  fetch:async(url,opt)=>{
    calls.push({url,opt});
    const path=new URL(url).pathname;
    let data=path==='/api/config'?{location_name:'Test Home'}:
      path==='/api/states'?[{entity_id:'sensor.temp',state:'21.5',attributes:{friendly_name:'Temperature',unit_of_measurement:'°C'}},
        {entity_id:'light.kitchen',state:'on',attributes:{friendly_name:'Kitchen'}}]:
      path==='/api/conversation/process'?{conversation_id:'abc',response:{speech:{plain:{speech:'Lights are on.'}}}}:
      {entity_id:'light.kitchen',state:'on',attributes:{}};
    return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>data,text:async()=>JSON.stringify(data)};
  },
  URL
};
vm.runInNewContext(fs.readFileSync(path.join(root,pkg.plugin.script),'utf8'),context);
function callConfig(m){return new Promise(resolve=>config(m,resolve));}
function callAction(name,args){return new Promise(resolve=>action({action:name,args:args||{}},{
  ok:x=>resolve({ok:true,...x}),error:(code,message)=>resolve({ok:false,code,message})}));}
function callSource(item){return new Promise(resolve=>source({item},{data:d=>resolve(d),error:(code,message)=>resolve({code,message})}));}
(async()=>{
  let s=await callConfig({type:'save',url:'https://ha.example.com',token:'secret'});
  assert.strictEqual(s.ok,true);
  assert.strictEqual(stored.ha_bridge_token,'secret');
  assert(!JSON.stringify(await callConfig({type:'status'})).includes('secret'));
  s=await callConfig({type:'test'});assert.strictEqual(s.name,'Test Home');
  let data=await callSource('entity');
  assert.strictEqual(data.instances.length,2);
  assert.strictEqual(data.instances[0].properties.value.numericValue.value,21.5);
  let discovery=await callConfig({type:'voice_discover'});
  assert(discovery.ok);
  assert(discovery.discovery.agents.some(a=>a.id==='conversation.google_ai'));
  assert(discovery.discovery.stt.some(e=>e.id==='stt.mock'));
  assert(discovery.discovery.tts.some(e=>e.id==='tts.mock'));
  assert(discovery.discovery.pipelines.some(p=>p.id==='pipeline-1'));
  assert.strictEqual(discovery.discovery.preferred_pipeline,'pipeline-1');
  let defaults=await callConfig({type:'voice_save',values:{
    stt_engine:'stt.test',tts_engine:'tts.test',agent_id:'conversation.google_ai',
    pipeline_id:'preferred-id'}});
  assert(defaults.ok);
  assert.strictEqual(defaults.defaults.agent_id,'conversation.google_ai');
  assert(!JSON.stringify(defaults).includes('secret'));
  let cfg=await callAction('get_config');
  assert(cfg.ok);
  assert.strictEqual(JSON.parse(cfg.text).pipeline_id,'preferred-id');
  assert(!cfg.text.includes('secret'));
  let r=await callAction('conversation',{text:'Hello'});
  assert(r.ok);assert(JSON.parse(r.text).text==='Lights are on.');
  const lastConversation=calls.filter(c=>c.url.endsWith('/api/conversation/process')).pop();
  assert.strictEqual(JSON.parse(lastConversation.opt.body).agent_id,'conversation.google_ai');
  await callConfig({type:'voice_save',values:{agent_id:''}});
  r=await callAction('call_service',{domain:'light',service:'turn_on',data:{entity_id:'light.kitchen'}});
  assert(r.ok);
  r=await callAction('read_api',{path:'/api/auth'});
  assert.strictEqual(r.code,'INVALID_ARGS');
  r=await callAction('call_service',{domain:'../auth',service:'x'});
  assert.strictEqual(r.code,'INVALID_ARGS');
  assert(calls.every(c=>c.opt.headers.Authorization==='Bearer secret'));
  assert(calls.some(c=>c.url.endsWith('/api/')&&!c.opt.headers['Content-Type']),
    'GET connection test must not send Content-Type');
  assert(calls.every(c=>c.opt.body || !c.opt.headers['Content-Type']),
    'Only requests with JSON bodies should declare Content-Type');
  s=await callConfig({type:'forget'});assert(s.ok);
  assert(!stored.ha_bridge_token);
  assert(!local.ha_voice_defaults_v1,'Forget also clears voice and AI preferences');
  console.log('Home Assistant plugin API and credential isolation checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
