// Home Assistant Bridge for Pebble plugins (preview API).
// Credentials never leave secureStorage and never appear in source/action results.
var URL_KEY='ha_bridge_url';
var TOKEN_KEY='ha_bridge_token';
var SOURCES=['agent/entity','agent/configured'];
function baseUrl() { return (localStorage.getItem(URL_KEY)||'').replace(/\/+$/,''); }
function validBase(value) {
  var s=String(value||'').trim().replace(/\/+$/,'');
  if(!/^https:\/\/[^\s/?#@]+(?::[0-9]{1,5})?$/i.test(s)) throw Error('Use an HTTPS server URL with no path, credentials or query.');
  return s;
}
function safeId(value) {return /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/.test(String(value||''));}
function safePart(value) {return /^[a-z][a-z0-9_]*$/.test(String(value||''));}
function failure(code,message){return {ok:false,code:code,message:message};}
async function api(path,method,body) {
  var url=baseUrl(),token=await Pebble.secureStorage.getItem(TOKEN_KEY);
  if(!url||!token)return failure('AUTH_REQUIRED','Configure the Home Assistant plugin.');
  try {
    var headers={'Authorization':'Bearer '+token,'Accept':'application/json'};
    // A GET request has no JSON body; do not advertise a Content-Type.
    // HA and reverse proxies can apply stricter request validation to GETs.
    if(typeof body!=='undefined')headers['Content-Type']='application/json';
    var res=await fetch(url+path,{
      method:method||'GET',headers:headers,
      body:typeof body==='undefined'?undefined:JSON.stringify(body)
    });
    if(!res.ok){
      var hint='';
      if(res.status===400){
        // Read the response for recognizable HA/proxy errors. Never display
        // arbitrary HTML, authentication data, or sensitive server details.
        try {
          var raw=String(await res.text()).toLowerCase();
          if(raw.indexOf('reverse proxy')!==-1 || raw.indexOf('forwarded')!==-1)
            hint=' (reverse proxy configuration rejected the request)';
          else if(raw.indexOf('invalid host')!==-1)
            hint=' (server rejected the host name)';
          else if(raw.indexOf('bad request')!==-1)
            hint=' (bad request; check Home Assistant logs)';
        }catch(e){}
      }
      return failure(res.status===401||res.status===403?'AUTH_REQUIRED':'PLUGIN_UNAVAILABLE',
        'Home Assistant HTTP '+res.status+hint);
    }
    var contentType=res.headers&&res.headers.get&&res.headers.get('content-type')||'';
    var data=contentType.indexOf('json')>=0?await res.json():await res.text();
    return {ok:true,data:data};
  }catch(e){
    // Never log the URL or token: they may contain private hostnames.
    return failure('PLUGIN_UNAVAILABLE','Home Assistant connection failed; check network permission and HTTPS.');
  }
}
// Shared, token-free voice/AI preferences. Changing these does not modify
// the user's Home Assistant server or its preferred Assist pipeline.
var DEFAULTS_KEY='ha_voice_defaults_v1';
function voiceDefaults() {
  var saved={};
  try{saved=JSON.parse(localStorage.getItem(DEFAULTS_KEY)||'{}')||{};}catch(e){}
  return {stt_engine:String(saved.stt_engine||''),
    tts_engine:String(saved.tts_engine||''),
    agent_id:String(saved.agent_id||''),
    pipeline_id:String(saved.pipeline_id||'')};
}
function saveVoiceDefaults(values) {
  var next=voiceDefaults();
  ['stt_engine','tts_engine','agent_id','pipeline_id'].forEach(function(key){
    if(Object.prototype.hasOwnProperty.call(values,key)) {
      var val=values[key];
      if(typeof val!=='string'||val.length>180)throw Error('Invalid '+key);
      next[key]=val;
    }
  });
  localStorage.setItem(DEFAULTS_KEY,JSON.stringify(next));
  return next;
}
// Request-scoped HA WebSocket discovery. Always close it after listing, never
// keep a persistent connection running in the plugin.
function wsList(type) {
  return new Promise(async function(resolve) {
    var socket=null,done=false,timer=null;
    function finish(value) {
      if(done)return;
      done=true;
      if(timer)clearTimeout(timer);
      if(socket){socket.onmessage=null;socket.onerror=null;socket.onclose=null;try{socket.close();}catch(e){}}
      resolve(value);
    }
    try{
      var url=baseUrl(),token=await Pebble.secureStorage.getItem(TOKEN_KEY);
      if(!url||!token||typeof WebSocket!=='function'){finish({ok:false,error:'WebSocket discovery unavailable'});return;}
      socket=new WebSocket(url.replace(/^https:/,'wss:')+'/api/websocket');
      timer=setTimeout(function(){finish({ok:false,error:'Discovery timed out'});},7000);
      socket.onmessage=function(event) {
        var msg;try{msg=JSON.parse(event.data);}catch(e){return;}
        if(msg.type==='auth_required')socket.send(JSON.stringify({type:'auth',access_token:token}));
        else if(msg.type==='auth_invalid')finish({ok:false,error:'Home Assistant rejected credentials'});
        else if(msg.type==='auth_ok')socket.send(JSON.stringify({id:1,type:type}));
        else if(msg.type==='result'&&msg.id===1)
          finish(msg.success?{ok:true,data:msg.result}:{ok:false,error:'HA discovery rejected'});
      };
      socket.onerror=function(){finish({ok:false,error:'WebSocket unavailable'});};
      socket.onclose=function(){finish({ok:false,error:'WebSocket disconnected'});};
    }catch(e){finish({ok:false,error:'WebSocket discovery failed'});}
  });
}
function uniqueOptions(options) {
  var seen={};return options.filter(function(o){
    if(!o.id||seen[o.id])return false;
    seen[o.id]=true;return true;
  }).sort(function(a,b){return a.name.localeCompare(b.name);});
}
async function discoverVoice() {
  var states=await api('/api/states');
  var results=await Promise.all([
    wsList('assist_pipeline/pipeline/list'),
    wsList('conversation/agent/list')
  ]);
  var pipelineResult=results[0],agentResult=results[1];
  var pipelines=pipelineResult.ok&&pipelineResult.data&&Array.isArray(pipelineResult.data.pipelines)
    ?pipelineResult.data.pipelines:[];
  var entities=states.ok&&Array.isArray(states.data)?states.data:[];
  var agents=[],tts=[],stt=[];
  entities.forEach(function(e){
    if(!e||typeof e.entity_id!=='string')return;
    var label=String(e.attributes&&e.attributes.friendly_name||e.entity_id);
    if(e.entity_id.indexOf('conversation.')===0)agents.push({id:e.entity_id,name:label});
    if(e.entity_id.indexOf('tts.')===0)tts.push({id:e.entity_id,name:label});
  });
  var list=agentResult.ok?(Array.isArray(agentResult.data)?agentResult.data:
    agentResult.data&&agentResult.data.agents||[]):[];
  list.forEach(function(a){
    if(a&&a.id)agents.push({id:String(a.id),name:String(a.name||a.id)});
  });
  pipelines.forEach(function(p){
    if(p.stt_engine)stt.push({id:String(p.stt_engine),name:String(p.stt_engine)});
    if(p.tts_engine)tts.push({id:String(p.tts_engine),name:String(p.tts_engine)});
    if(p.conversation_engine)agents.push({id:String(p.conversation_engine),name:String(p.conversation_engine)});
  });
  return {
    defaults:voiceDefaults(),
    agents:uniqueOptions(agents),tts:uniqueOptions(tts),stt:uniqueOptions(stt),
    pipelines:pipelines.map(function(p){return {
      id:String(p.id),name:String(p.name||p.id),
      stt_engine:p.stt_engine||'',tts_engine:p.tts_engine||'',
      conversation_engine:p.conversation_engine||''
    };}),
    preferred_pipeline:pipelineResult.ok&&pipelineResult.data?pipelineResult.data.preferred_pipeline||'':'',
    warnings:[!states.ok?'Entity discovery unavailable':null,
      !pipelineResult.ok?'Assist pipeline discovery unavailable':null,
      !agentResult.ok?'Conversation agent discovery unavailable':null].filter(Boolean)
  };
}
function compact(state){
  var a=state.attributes||{};
  return {entity_id:state.entity_id,state:state.state,
    friendly_name:String(a.friendly_name||state.entity_id),
    unit:String(a.unit_of_measurement||''),
    attributes:a,last_changed:state.last_changed};
}
function sourceProperties(state) {
  var a=state.attributes||{},text=String(state.state||'unknown');
  var prop={name:{shortText:{text:String(a.friendly_name||state.entity_id).slice(0,120)}},
    entity_id:{shortText:{text:state.entity_id}},
    domain:{shortText:{text:state.entity_id.split('.')[0]}},
    state:{shortText:{text:text.slice(0,90)},longText:{text:text.slice(0,500)}}};
  var n=Number(text);
  if(text.trim()&&isFinite(n)) {
    prop.value={numericValue:{value:n,unit:String(a.unit_of_measurement||'').slice(0,24)}};
  }
  if(text==='on'||text==='off')prop.on={boolean:{value:text==='on'}};
  if(a.unit_of_measurement)prop.unit={shortText:{text:String(a.unit_of_measurement).slice(0,32)}};
  return prop;
}
Pebble.registerSourceHandler(async function(request,respond){
  if(request.item==='configured'){
    var present=!!baseUrl()&&!!(await Pebble.secureStorage.getItem(TOKEN_KEY));
    respond.data({validUntilMs:Date.now()+120000,instances:[{
      instanceId:'home',properties:{name:{shortText:{text:'Home Assistant'}},
        configured:{boolean:{value:present}}}}]});return;
  }
  if(request.item!=='entity'){respond.error('INVALID_REQUEST','Unknown source');return;}
  var result=await api('/api/states');
  if(!result.ok){respond.error(result.code,result.message);return;}
  if(!Array.isArray(result.data)){respond.error('UNKNOWN','Unexpected states response');return;}
  respond.data({validUntilMs:Date.now()+30000,instances:result.data.slice(0,400).map(function(state){
    return {instanceId:state.entity_id,properties:sourceProperties(state)};
  })});
});
// Pebble restarts the plugin script for EVERY action. TTS chunks therefore
// live briefly in plugin-owned localStorage, never in JS module variables.
// These are transient speech bytes (not credentials); release/TTL removes them.
var MAX_TTS_BYTES=1500000,TTS_CHUNK_BYTES=6000;
var TTS_INDEX_KEY='ha_tts_sessions_v2',TTS_TTL_MS=180000;
function base64Bytes(bytes) {
  var abc='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var out='';
  for(var i=0;i<bytes.length;i+=3){
    var a=bytes[i],b=i+1<bytes.length?bytes[i+1]:0,c=i+2<bytes.length?bytes[i+2]:0;
    out+=abc[a>>2]+abc[((a&3)<<4)|(b>>4)]+(i+1<bytes.length?abc[((b&15)<<2)|(c>>6)]:'=')+
      (i+2<bytes.length?abc[c&63]:'=');
  }
  return out;
}
function sessionKey(id){return 'ha_tts_v2_'+id;}
function sessionList(){
  try{var value=JSON.parse(localStorage.getItem(TTS_INDEX_KEY)||'[]');
    return Array.isArray(value)?value:[];}catch(e){return [];}
}
function deleteTtsSession(id){
  var key=sessionKey(id),raw=localStorage.getItem(key),count=0;
  try{count=JSON.parse(raw||'{}').count||0;}catch(e){}
  // Reject tampered metadata that would otherwise trigger unbounded deletion.
  count=Math.min(251,Math.max(0,count));
  for(var i=0;i<count;i++)localStorage.removeItem(key+'_'+i);
  localStorage.removeItem(key);
}
function cleanTtsSessions(){
  var now=Date.now(),keep=[];
  sessionList().forEach(function(id){
    if(!/^tts[a-z0-9]+$/.test(id))return;
    var meta=null;
    try{meta=JSON.parse(localStorage.getItem(sessionKey(id))||'null');}catch(e){}
    if(!meta||meta.expires<now){deleteTtsSession(id);return;}
    keep.push(id);
  });
  localStorage.setItem(TTS_INDEX_KEY,JSON.stringify(keep));
  return keep;
}
function storeTtsSession(bytes){
  var keep=cleanTtsSessions();
  // Keep a single audio session to bound storage usage on the phone.
  keep.forEach(deleteTtsSession);
  localStorage.setItem(TTS_INDEX_KEY,'[]');
  var id='tts'+Date.now().toString(36)+Math.floor(Math.random()*0x100000000).toString(36);
  var key=sessionKey(id),count=Math.ceil(bytes.length/TTS_CHUNK_BYTES);
  var meta={length:bytes.length,count:count,expires:Date.now()+TTS_TTL_MS};
  try{
    localStorage.setItem(key,JSON.stringify(meta));
    for(var i=0;i<count;i++){
      var start=i*TTS_CHUNK_BYTES;
      localStorage.setItem(key+'_'+i,base64Bytes(bytes.subarray(start,start+TTS_CHUNK_BYTES)));
    }
    localStorage.setItem(TTS_INDEX_KEY,JSON.stringify([id]));
    return {session_id:id,length:bytes.length,chunk_bytes:TTS_CHUNK_BYTES};
  }catch(e){
    deleteTtsSession(id);
    return null;
  }
}
// Reconcile PCM WAV metadata against the fully fetched response. Streaming TTS
// engines sometimes advertise a finite but incorrect data size. Only repair
// a valid mono/8kHz/16-bit PCM data chunk; never reinterpret other codecs.
function normalizeStreamedWav(bytes) {
  if(bytes.length<44)return {ok:false,error:'WAV too short ('+bytes.length+' bytes)'};
  var view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  function tag(pos){return String.fromCharCode(bytes[pos],bytes[pos+1],bytes[pos+2],bytes[pos+3]);}
  if(tag(0)!=='RIFF'||tag(8)!=='WAVE')return {ok:false,error:'TTS did not return RIFF WAV'};
  var offset=12,fmt=null,dataOffset=-1,declared=0;
  while(offset+8<=bytes.length){
    var name=tag(offset),size=view.getUint32(offset+4,true),start=offset+8;
    if(name==='fmt '){
      if(size<16||size>bytes.length-start)return {ok:false,error:'Invalid WAV fmt length'};
      fmt={encoding:view.getUint16(start,true),channels:view.getUint16(start+2,true),
        rate:view.getUint32(start+4,true),bits:view.getUint16(start+14,true)};
    }
    if(name==='data') {dataOffset=offset;declared=size;break;}
    if(size>bytes.length-start)return {ok:false,error:'Truncated WAV '+name+' chunk'};
    offset=start+size+(size%2);
  }
  if(!fmt||dataOffset<0)return {ok:false,error:'Missing WAV format or PCM data'};
  if(fmt.encoding!==1||fmt.channels!==1||fmt.rate!==8000||fmt.bits!==16)
    return {ok:false,error:'TTS must return mono 8kHz 16-bit PCM WAV'};
  var available=bytes.length-(dataOffset+8),usable=available-(available%2);
  if(usable<2)return {ok:false,error:'Empty WAV PCM payload'};
  // A response may be actually cut short despite HTTP success. We can still
  // play its complete PCM samples; return a warning describing the shortfall.
  var declaredRiff=view.getUint32(4,true);
  var needsFix=declared!==usable||declaredRiff!==bytes.length-8;
  var warning='';
  if(declared>usable&&declared!==0xFFFFFFFF&&declared!==0x7FFFFFFF)
    warning='WAV declared '+declared+' PCM bytes; received '+usable;
  if(needsFix){
    view.setUint32(dataOffset+4,usable,true);
    view.setUint32(4,bytes.length-8,true);
  }
  return {ok:true,bytes:bytes,warning:warning,received:usable,declared:declared,
    corrected:needsFix};
}
async function prepareTts(args){
  if(typeof args.text!=='string'||!args.text.trim()||args.text.length>500)
    return failure('INVALID_ARGS','Speech text must contain 1–500 characters');
  var engine=String(args.engine_id||voiceDefaults().tts_engine||'');
  if(!/^tts\.[a-z0-9_]+$/.test(engine))
    return failure('INVALID_ARGS','Select a TTS engine in Home Assistant Bridge settings');
  var generated=await api('/api/tts_get_url','POST',{
    engine_id:engine,message:args.text,cache:true,
    options:{preferred_format:'wav',preferred_sample_rate:8000,
      preferred_sample_channels:1,preferred_sample_bytes:2}
  });
  if(!generated.ok)return generated;
  var path=generated.data&&generated.data.path;
  if(typeof path!=='string'||!/^\/api\/tts_proxy\/[a-zA-Z0-9_./%-]+$/.test(path))
    return failure('PLUGIN_UNAVAILABLE','Home Assistant did not return a valid TTS path');
  var token=await Pebble.secureStorage.getItem(TOKEN_KEY);
  try {
    var res=await fetch(baseUrl()+path,{headers:{Authorization:'Bearer '+token}});
    if(!res.ok)return failure('PLUGIN_UNAVAILABLE','TTS audio HTTP '+res.status);
    var bytes=new Uint8Array(await res.arrayBuffer());
    if(bytes.length<44||bytes.length>MAX_TTS_BYTES)
      return failure('PLUGIN_UNAVAILABLE','TTS audio is empty or exceeds size limit');
    var normalized=normalizeStreamedWav(bytes);
    if(!normalized.ok)return failure('PLUGIN_UNAVAILABLE',normalized.error);
    if(normalized.warning)console.log('Home Assistant TTS: '+normalized.warning);
    var session=storeTtsSession(normalized.bytes);
    if(!session)return failure('PLUGIN_UNAVAILABLE','Insufficient plugin storage for TTS audio');
    return {ok:true,data:session};
  }catch(e){return failure('PLUGIN_UNAVAILABLE','Unable to fetch Home Assistant speech audio');}
}
function ttsChunk(args){
  cleanTtsSessions();
  var id=String(args.session_id||''),offset=Number(args.offset);
  if(!/^tts[a-z0-9]+$/.test(id))return failure('INVALID_ARGS','Invalid TTS session');
  var meta=null;
  try{meta=JSON.parse(localStorage.getItem(sessionKey(id))||'null');}catch(e){}
  if(!meta)return failure('PLUGIN_UNAVAILABLE','TTS session expired; start a new request');
  if(!Number.isInteger(offset)||offset<0||offset>=meta.length||offset%TTS_CHUNK_BYTES!==0)
    return failure('INVALID_ARGS','Invalid TTS chunk offset');
  var index=offset/TTS_CHUNK_BYTES;
  var audio=localStorage.getItem(sessionKey(id)+'_'+index);
  if(!audio)return failure('PLUGIN_UNAVAILABLE','TTS audio chunk unavailable');
  meta.expires=Date.now()+TTS_TTL_MS;
  localStorage.setItem(sessionKey(id),JSON.stringify(meta));
  return {ok:true,data:{offset:offset,length:meta.length,audio:audio,
    done:index===meta.count-1}};
}
var SAFE_READ=/^\/api\/(?:config|services|states(?:\/[a-z][a-z0-9_]*\.[a-z0-9_]+)?|calendars|history\/period(?:\/[0-9TZ:+.-]+)?|logbook(?:\/[0-9TZ:+.-]+)?)(?:\?[a-zA-Z0-9_=&%.,:+-]+)?$/;
Pebble.registerActionHandler(async function(request,respond) {
  var args=request.args||{},r,refresh=[];
  switch(request.action){
    case 'get_state':
      if(!safeId(args.entity_id)){respond.error('INVALID_ARGS','Invalid entity_id');return;}
      r=await api('/api/states/'+encodeURIComponent(args.entity_id));break;
    case 'list_states':
      r=await api('/api/states');
      if(r.ok&&Array.isArray(r.data)){
        var domain=args.domain;
        if(domain&&!safePart(domain)){respond.error('INVALID_ARGS','Invalid domain');return;}
        var states=r.data.filter(function(x){return !domain||x.entity_id.indexOf(domain+'.')===0;});
        r.data=states.slice(0,Math.min(100,Math.max(1,Number(args.limit)||50))).map(compact);
      }
      break;
    case 'read_api':
      if(typeof args.path!=='string'||!SAFE_READ.test(args.path)){
        respond.error('INVALID_ARGS','API path not on read-only allowlist');return;
      }
      r=await api(args.path);break;
    case 'get_config':
      r={ok:true,data:voiceDefaults()};break;
    case 'tts_prepare':
      r=await prepareTts(args);break;
    case 'tts_chunk':
      r=ttsChunk(args);break;
    case 'tts_release':
      deleteTtsSession(String(args.session_id||''));
      localStorage.setItem(TTS_INDEX_KEY,JSON.stringify(sessionList().filter(function(id){
        return id!==String(args.session_id||'');
      })));
      r={ok:true,data:{released:true}};break;
    case 'conversation':
      if(typeof args.text!=='string'||!args.text.trim()||args.text.length>4000){
        respond.error('INVALID_ARGS','Message must contain 1–4000 characters');return;
      }
      var body={text:args.text,language:'en'};
      var selectedAgent=args.agent_id||voiceDefaults().agent_id;
      if(selectedAgent)body.agent_id=String(selectedAgent);
      if(args.conversation_id)body.conversation_id=String(args.conversation_id);
      r=await api('/api/conversation/process','POST',body);
      if(r.ok){
        var d=r.data||{},speech=d.response&&d.response.speech&&d.response.speech.plain;
        r.data={text:String(speech&&speech.speech||''),conversation_id:d.conversation_id||'',
          response_type:d.response&&d.response.response_type||''};
      }
      break;
    case 'render_template':
      if(typeof args.template!=='string'||args.template.length>4000){
        respond.error('INVALID_ARGS','Template too long');return;
      }
      r=await api('/api/template','POST',{template:args.template});break;
    case 'call_service':
      if(!safePart(args.domain)||!safePart(args.service)){
        respond.error('INVALID_ARGS','Invalid service');return;
      }
      var payload=Object.assign({},args.data||{});
      if(args.target)payload.target=args.target;
      r=await api('/api/services/'+args.domain+'/'+args.service,'POST',payload);
      refresh=['agent/entity'];break;
    case 'fire_event':
      if(!safePart(args.event_type)){respond.error('INVALID_ARGS','Invalid event type');return;}
      r=await api('/api/events/'+args.event_type,'POST',args.event_data||{});break;
    default:respond.error('INVALID_REQUEST','Unknown action');return;
  }
  if(!r.ok){respond.error(r.code,r.message);return;}
  // Structured JSON replies are carried in result data; never include credentials.
  respond.ok({text:typeof r.data==='string'?r.data.slice(0,2000):
    JSON.stringify(r.data).slice(0,20000),refreshed:refresh});
  if(refresh.length)Pebble.refreshSources(refresh);
});
Pebble.registerConfigHandler(async function(message,respond){
  switch(message&&message.type){
    case 'status':{
      var hasToken=!!(await Pebble.secureStorage.getItem(TOKEN_KEY));
      respond({url:baseUrl(),hasToken:hasToken,configured:!!baseUrl()&&hasToken});return;
    }
    case 'save':{
      try{
        var url=validBase(message.url);
        if(typeof message.token==='string'&&message.token.trim()){
          await Pebble.secureStorage.setItem(TOKEN_KEY,message.token.trim());
        } else if(!(await Pebble.secureStorage.getItem(TOKEN_KEY))){
          respond({ok:false,error:'Enter a Home Assistant token.'});return;
        }
        localStorage.setItem(URL_KEY,url);
        Pebble.refreshSources(SOURCES);
        respond({ok:true,url:url});return;
      }catch(e){respond({ok:false,error:e.message});return;}
    }
    case 'voice_status':
      respond({ok:true,defaults:voiceDefaults()});return;
    case 'voice_discover':
      respond({ok:true,discovery:await discoverVoice()});return;
    case 'voice_save':
      try {respond({ok:true,defaults:saveVoiceDefaults(message.values||{})});}
      catch(e){respond({ok:false,error:e.message});}
      return;
    case 'test':{
      // Check an inexpensive API endpoint first, then the authenticated
      // configuration endpoint to pinpoint where a 400 originates.
      var ping=await api('/api/');
      if(!ping.ok){
        respond({ok:false,error:ping.message,stage:'/api/'});
        return;
      }
      var result=await api('/api/config');
      respond(result.ok?{ok:true,name:result.data&&result.data.location_name||'Home Assistant'}:
        {ok:false,error:result.message,stage:'/api/config'});
      return;
    }
    case 'forget':
      await Pebble.secureStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(URL_KEY);
      localStorage.removeItem(DEFAULTS_KEY);
      Pebble.refreshSources(SOURCES);
      respond({ok:true});return;
    default:respond({ok:false,error:'Unknown configuration request'});
  }
});
