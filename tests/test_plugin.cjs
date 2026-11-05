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
for(const name of ['tts_prepare','tts_chunk','tts_release'])
  assert(pkg.plugin.actions.find(a=>a.name===name).callerPermissions.includes('HomeConverse'));

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
      path==='/api/tts_get_url'?{path:'/api/tts_proxy/demo.wav'}:
      {entity_id:'light.kitchen',state:'on',attributes:{}};
    if(path==='/api/tts_proxy/demo.wav'){
      const wav=new Uint8Array(44+32000);
      wav.set(Buffer.from('RIFF', 'ascii'),0);
      wav.set(Buffer.from('WAVEfmt ', 'ascii'),8);
      wav.set(Buffer.from('data', 'ascii'),36);
      const hdr=new DataView(wav.buffer);
      hdr.setUint32(4,0xFFFFFFFF,true); // streaming RIFF size
      hdr.setUint32(16,16,true); // fmt size
      hdr.setUint16(20,1,true); // PCM
      hdr.setUint16(22,1,true); // mono
      hdr.setUint32(24,16000,true);
      for(let i=0;i<16000;i++)hdr.setInt16(44+i*2,Math.round(11000*Math.sin(2*Math.PI*440*i/16000)),true);
      hdr.setUint16(34,16,true);
      hdr.setUint32(40,0x7FFFFFFF,true); // alternate indefinite data size
      return {ok:true,status:200,arrayBuffer:async()=>wav.buffer};
    }
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
  const speech=await callAction('tts_prepare',{text:'Lights are on.'});
  assert(speech.ok,'Plugin should prepare compressed speech without exporting credentials');
  const meta=JSON.parse(speech.text);
  assert.strictEqual(meta.format,'ima_adpcm4');
  assert.strictEqual(meta.sample_rate,16000);
  assert.strictEqual(meta.channels,1);
  assert.strictEqual(meta.sample_count,16000);
  assert.strictEqual(meta.length,8000,'4-bit ADPCM must reduce PCM16 size 4x');
  assert(meta.next_index>=0&&meta.next_index<=88);
  assert(meta.next_predictor>=-32768&&meta.next_predictor<=32767);
  // Pebble starts a fresh plugin JS context for every action.
  vm.runInNewContext(fs.readFileSync(path.join(root,pkg.plugin.script),'utf8'),context);
  let audio=[];
  for(let offset=0;offset<meta.length;offset+=meta.chunk_bytes){
    const reply=await callAction('tts_chunk',{session_id:meta.session_id,offset});
    assert(reply.ok,'Chunk '+offset+' should be readable');
    const payload=JSON.parse(reply.text);
    assert.strictEqual(payload.offset,offset);
    audio.push(Buffer.from(payload.audio,'base64'));
    vm.runInNewContext(fs.readFileSync(path.join(root,pkg.plugin.script),'utf8'),context);
  }
  const compressed=Buffer.concat(audio);
  assert.strictEqual(compressed.length,meta.length);
  // Independent IMA decoder verifies nibble order, waveform, and continuity.
  const steps=[7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,
    41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,
    253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,
    1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,
    4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,
    12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
  const changes=[-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];
  let pred=0,idx=0,error=0;
  for(let i=0;i<16000;i++){
    const nib=(i&1)?compressed[i>>1]&15:compressed[i>>1]>>4;
    const step=steps[idx];
    let delta=step>>3;
    if(nib&4)delta+=step;
    if(nib&2)delta+=step>>1;
    if(nib&1)delta+=step>>2;
    pred=Math.max(-32768,Math.min(32767,pred+((nib&8)?-delta:delta)));
    idx=Math.max(0,Math.min(88,idx+changes[nib]));
    error+=Math.abs(pred-Math.round(11000*Math.sin(2*Math.PI*440*i/16000)));
  }
  assert(error/16000<1800,'Compressed speech should remain recognizable');
  assert.strictEqual(pred,meta.next_predictor);
  assert.strictEqual(idx,meta.next_index);
  // Reject codecs not supported by the compressed-audio path.
  const wav=new Uint8Array(44+32000);
  wav.set(Buffer.from('RIFF'),0);wav.set(Buffer.from('WAVEfmt '),8);
  wav.set(Buffer.from('data'),36);
  const v=new DataView(wav.buffer);v.setUint32(16,16,true);
  v.setUint16(20,3,true);v.setUint16(22,1,true);
  v.setUint32(24,16000,true);v.setUint16(34,16,true);
  const parse=vm.runInNewContext('wavPcm16',context);
  assert.strictEqual(parse(wav).ok,false,'Non-PCM format cannot be silently accepted');
  const end=await callAction('tts_release',{session_id:meta.session_id});
  assert(end.ok);
  const gone=await callAction('tts_chunk',{session_id:meta.session_id,offset:0});
  assert.strictEqual(gone.ok,false,'Released audio sessions must be unavailable');
  const ttsPost=calls.find(c=>c.url.endsWith('/api/tts_get_url'));
  assert.strictEqual(JSON.parse(ttsPost.opt.body).engine_id,'tts.test');
  assert(!speech.text.includes('secret'),'Audio action must not return credentials');
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
