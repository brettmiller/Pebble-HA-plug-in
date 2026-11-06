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
      assert.strictEqual(opt.responseType,'arraybuffer',
        'Pebble plugin fetch must request binary responseType before downloading WAV');
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
  // A 16kHz HA WAV must be normalized to the precise 8kHz PCM16 WAV
  // that Gemini's phone-side lowPassFilter/encodeADPCM pipeline expects.
  // Bridge-origin tone uses the same persisted WAV session and chunk transport.
  // Unlike a phone-generated tone, it exercises every plugin byte boundary.
  let reference=await callAction('tts_prepare',{test_tone:true});
  assert(reference.ok,'Bridge diagnostic must not require a TTS provider');
  let refMeta=JSON.parse(reference.text);
  assert.strictEqual(refMeta.length,112044);
  assert.strictEqual(refMeta.sample_rate,8000);
  assert.strictEqual(refMeta.audio_diagnostics.source,'bridge_test_tone');
  let refParts=[];
  for(let off=0;off<refMeta.length;off+=refMeta.chunk_bytes){
    vm.runInNewContext(fs.readFileSync(path.join(root,pkg.plugin.script),'utf8'),context);
    const part=await callAction('tts_chunk',{session_id:refMeta.session_id,offset:off});
    assert(part.ok,'Bridge tone chunk '+off);
    refParts.push(Buffer.from(JSON.parse(part.text).audio,'base64'));
  }
  const refWave=Buffer.concat(refParts);
  let refHash=2166136261>>>0;
  for(const b of refWave)refHash=Math.imul((refHash^b)>>>0,16777619)>>>0;
  assert.strictEqual(refHash,refMeta.wav_checksum);
  assert.strictEqual(refWave.readUInt32LE(24),8000);
  await callAction('tts_release',{session_id:refMeta.session_id});
  const speech=await callAction('tts_prepare',{text:'Lights are on.'});
  assert(speech.ok,'Plugin should deliver a valid WAV without exporting credentials');
  const meta=JSON.parse(speech.text);
  assert.strictEqual(meta.format,'pcm_s16le_wav');
  assert.strictEqual(meta.sample_rate,8000);
  assert.strictEqual(meta.channels,1);
  assert.strictEqual(meta.bits_per_sample,16);
  assert.strictEqual(meta.sample_count,8000);
  assert.strictEqual(meta.length,16044);
  assert.strictEqual(meta.audio_diagnostics.input_rate,16000);
  assert(meta.audio_diagnostics.byte_order);
  assert(meta.audio_diagnostics.byte_order.examined_samples>0);
  assert(meta.audio_diagnostics.byte_order.little_endian.rms>0);
  assert(meta.audio_diagnostics.byte_order.big_endian.rms>0);
  assert.strictEqual(meta.audio_diagnostics.source,'home_assistant');
  assert.strictEqual(meta.audio_diagnostics.binary_transport,'fetch_arraybuffer');
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
  const wav=Buffer.concat(audio);
  assert.strictEqual(wav.length,meta.length);
  let check=2166136261>>>0;
  for(const byte of wav)check=Math.imul((check^byte)>>>0,16777619)>>>0;
  assert.strictEqual(meta.wav_checksum,check,'WAV checksum must cover every transmitted byte');
  assert.strictEqual(wav.toString('ascii',0,4),'RIFF');
  assert.strictEqual(wav.toString('ascii',8,12),'WAVE');
  assert.strictEqual(wav.toString('ascii',12,16),'fmt ');
  assert.strictEqual(wav.toString('ascii',36,40),'data');
  assert.strictEqual(wav.readUInt32LE(4),wav.length-8);
  assert.strictEqual(wav.readUInt32LE(40),16000);
  assert.strictEqual(wav.readUInt16LE(20),1);
  assert.strictEqual(wav.readUInt16LE(22),1);
  assert.strictEqual(wav.readUInt32LE(24),8000);
  assert.strictEqual(wav.readUInt16LE(34),16);
  let error=0;
  for(let i=0;i<8000;i++)
    error+=Math.abs(wav.readInt16LE(44+i*2)-
      Math.round(11000*Math.sin(2*Math.PI*440*i/8000)));
  assert(error/8000<600,'Resampling should preserve the speech-band tone');
  // Reject non-PCM instead of passing compressed bytes as PCM samples.
  const unsupported=new Uint8Array(wav);
  new DataView(unsupported.buffer).setUint16(20,3,true);
  const parse=vm.runInNewContext('wavPcm16',context);
  assert.strictEqual(parse(unsupported).ok,false);
  // The captured broken HTTP response had 0xFDFDFDFD where streaming WAV
  // uses an indefinite data size, and 0x3EFD where 16kHz is 0x3E80.
  // Detect this as binary corruption, not a new valid streaming marker.
  const isMangled=vm.runInNewContext('looksLikeMangledBinary',context);
  const damaged=Buffer.from(wav);
  damaged.writeUInt32LE(0xFDFDFDFD,40);
  assert.strictEqual(isMangled(new Uint8Array(damaged)),true);
  assert.strictEqual(isMangled(new Uint8Array(wav)),false);
  // Access to XMLHttpRequest is explicitly blocked in plugin contexts.
  // No plugin code should even evaluate typeof XMLHttpRequest.
  Object.defineProperty(context,'XMLHttpRequest',{
    configurable:true,
    get(){throw Error('XMLHttpRequest is not available to plugins');}
  });
  vm.runInNewContext(fs.readFileSync(path.join(root,pkg.plugin.script),'utf8'),context);
  const stillWorks=await callAction('tts_prepare',{text:'Testing safe plugin fetch'});
  assert(stillWorks.ok,'Plugin fetch must work even with throwing XHR global');
  await callAction('tts_release',{session_id:JSON.parse(stillWorks.text).session_id});
  // WAV may have metadata after its finite data chunk. Do not interpret
  // those trailing chunks as speech; doing so creates audible noise.
  const withTrailer=Buffer.alloc(wav.length+20);
  wav.copy(withTrailer,0);
  withTrailer.write('LIST',wav.length,'ascii');
  withTrailer.writeUInt32LE(12,wav.length+4);
  withTrailer.fill(0x7f,wav.length+8);
  // A nonstandard 0xFDFDFDFD length is an unknown-size streamed WAV,
  // not 4.26 GB of audio; trust only the complete received samples.
  const streamedFixture=Buffer.from(wav);
  streamedFixture.writeUInt32LE(0xFDFDFDFD,40);
  const streamedParsed=parse(new Uint8Array(streamedFixture));
  assert(streamedParsed.ok);
  assert.strictEqual(streamedParsed.samples.length,8000);
  assert.strictEqual(streamedParsed.streamed_data,true);
  const trailingParsed=parse(new Uint8Array(withTrailer));
  assert(trailingParsed.ok);
  assert.strictEqual(trailingParsed.samples.length,8000);
  assert.strictEqual(trailingParsed.available_data_bytes,16020);
  assert.strictEqual(trailingParsed.used_data_bytes,16000);
  // Diagnostic source rate must be forwarded but output format stays Gemini.
  const sourceTest=await callAction('tts_prepare',{
    text:'Diagnostic phrase',source_rate:16000,diagnostic:true
  });
  assert(sourceTest.ok,'Uncached high-rate TTS source should work');
  const sourceMeta=JSON.parse(sourceTest.text);
  assert.strictEqual(sourceMeta.sample_rate,8000);
  assert.strictEqual(sourceMeta.audio_diagnostics.requested_rate,16000);
  const latestPost=calls.filter(c=>c.url.endsWith('/api/tts_get_url')).pop();
  const latestBody=JSON.parse(latestPost.opt.body);
  assert.strictEqual(latestBody.cache,false);
  assert.strictEqual(latestBody.options.preferred_sample_rate,16000);
  await callAction('tts_release',{session_id:sourceMeta.session_id});
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
