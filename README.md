# Home Assistant Bridge — Pebble Plugin Preview

Standalone, phone-side Pebble plugin for reusable access to a user's Home Assistant installation.

## Install

1. Enable **Settings → Plugins → Plugins / permissions preview** in the Pebble mobile app.
2. Build or download the GitHub Actions **Build Home Assistant Plugin** artifact.
3. Extract and sideload the plugin-only `.pbw`. It won't appear as a watchapp.
4. Open the **Home Assistant Bridge** plugin's settings page in Pebble.
5. Set your externally reachable **HTTPS** Home Assistant URL and a long-lived access token.
6. Grant the network permissions; tap **Test connection**.
7. Install an app using the plugin and grant its declared read/converse/control permissions.

Token storage uses `Pebble.secureStorage`, private to the plugin and backed by the phone keystore. A plugin-enabled watchapp doesn't receive the token.

## Public interface

Plugin UUID: `a74370b6-929c-4ec0-b7ee-2fc6fca8db57`.

Sources:

- `agent/configured`: whether a URL and token are configured.
- `agent/entity`: state, numeric/boolean readings, name, unit, domain and ID from HA states. Up to 400 entries per update; use `get_state` for an entity not in the first update.

Actions:

| Action | Arguments | Permission | Purpose |
| --- | --- | --- | --- |
| `get_state` | `{entity_id}` | HomeRead | Read one entity |
| `list_states` | `{domain?, limit?}` | HomeRead | List up to 100 entity states |
| `get_config` | `{}` | HomeRead | Read shared STT/TTS/agent/pipeline defaults (no credentials) |
| `read_api` | `{path}` | HomeRead | Allowlisted read-only HA API GET |
| `conversation` | `{text, agent_id?, conversation_id?}` | HomeConverse | Call HA conversation/process |
| `tts_prepare` | `{text, engine_id?}` | HomeConverse | Request 16kHz mono PCM16 speech from HA, resample if necessary, encode as 16kHz 4-bit IMA ADPCM; optional `{predictor,index}` carry state across sentences. Returns session ID, byte count, codec metadata and `{next_predictor,next_index}` |
| `tts_chunk` | `{session_id, offset}` | HomeConverse | Return a base64 IMA ADPCM chunk (up to 6000 compressed bytes) |
| `tts_release` | `{session_id}` | HomeConverse | Free temporary speech data |
| `render_template` | `{template}` | HomeControl | Render a trusted HA Jinja template |
| `call_service` | `{domain,service,data?,target?}` | HomeControl | Invoke an arbitrary HA service |
| `fire_event` | `{event_type,event_data?}` | HomeControl | Fire an HA event |

The generic service and event operations can affect locks, alarms, garage doors or other sensitive entities. Use a dedicated least-privileged HA account, and grant `HomeControl` only to trusted apps. Plugin permissions are enforced by the Pebble host, not by these JavaScript handlers themselves.

Action success results use `{ok:true, text:"<JSON or text>", refreshed:[...]}`; parse `text` for returned structured data. Errors use Pebble standard error codes.

Example consumer (from PebbleKit JS):

```js
const PLUGIN = "a74370b6-929c-4ec0-b7ee-2fc6fca8db57";
const result = await Pebble.invokeAction({
  plugin: PLUGIN, action: "get_state", args: { entity_id: "sensor.outdoor_temperature" }
});
if (result.ok) {
  const entity = JSON.parse(result.text);
  console.log(entity.state);
}
```

Consumer manifests must declare `{ "name": "HomeRead", "plugin": "<UUID>" }` and `{ "name": "InvokeAction", "plugin": "<UUID>" }`. Add `HomeConverse` or `HomeControl` for the other actions as required.

## Shared voice and AI settings

Open the plugin settings and configure **Voice & AI defaults**. The plugin discovers available conversation agents and configured TTS entities through Home Assistant states and its conversation-agent WebSocket API. It also retrieves Assist pipelines and their STT/TTS engines through `assist_pipeline/pipeline/list`. Choose a conversation agent, STT engine, TTS engine, and pipeline; then save.

These choices are stored locally to the plugin, not written into Home Assistant's server settings. The list of STT/TTS engines is limited to engines exposed by current Assist pipelines and TTS entities; unavailable engines cannot be enumerated by this implementation. A selected STT engine does not reconfigure the chosen pipeline automatically. To actually run speech recognition with a particular STT engine, configure an Assist pipeline using that engine in Home Assistant.

The `get_config` action gives other Pebble apps a token-free JSON object with `stt_engine`, `tts_engine`, `agent_id`, and `pipeline_id`. The existing `conversation` action honors the selected `agent_id` unless the caller supplies an explicit override.

```js
const result = await Pebble.invokeAction({
  plugin: PLUGIN, action: 'get_config', args: {}
});
const preferences = JSON.parse(result.text);
```

The plugin now exposes 16 kHz, 4-bit IMA ADPCM audio through request-scoped, base64-encoded chunks. Home Assistant is asked for mono PCM16 WAV at 16 kHz; the plugin checks the actual format, resamples supported mono PCM16 if needed, and compresses it before storing chunks. Audio is fetched and stored temporarily in plugin-owned localStorage in bounded base64 chunks; the consuming app handles WAV decoding and watch playback without Home Assistant credentials. This is required because Pebble starts a fresh plugin JavaScript instance for every action. Sessions expire after three minutes of inactivity and should be explicitly released. Only one in-progress session is retained, and temporary audio is not stored in the credential keystore. This has higher request overhead than a streaming API. Continuous microphone / Assist WebSocket streaming is not exposed by the current plugin API.

## Watchapp compatibility

Home Assistant AI v0.2.x offers a **Use Home Assistant plugin** settings toggle. The plugin-backed path uses `conversation` for one-shot dictation, without copying the token into watchapp storage, and uses `tts_prepare` / `tts_chunk` for spoken responses when enabled. The `continuous-native-conversation` consumer branch receives and forwards IMA ADPCM directly to the watch's 16 kHz decoder, without double-encoding.

**Limitation:** Continuous watch microphone streaming is not yet supported in plugin mode. It requires a long-running binary Assist WebSocket; current plugin actions are request-scoped and expose no streaming bridge. The watchapp blocks this feature while plugin mode is selected rather than silently using direct credentials. One-shot watch dictation and text-to-speech responses use only the plugin. Plugin-owned audio sessions rely on the plugin preview runtime retaining an active handler instance across chunk requests and require testing on a physical phone/watch.

## Build

GitHub Actions: `.github/workflows/build-ha-plugin.yml` packages the plugin with a pinned version of Pebble's official `pack-plugin-pbw.py`. No SDK or local installation is necessary for the plugin-only package.

The Pebble plugin API is still evolving. Test updates using the current Pebble mobile app, and verify store submission requirements before publishing.

## Compressed speech contract (v0.2.5)

`tts_prepare` returns `{session_id,length,chunk_bytes,format:'ima_adpcm4',sample_rate:16000,channels:1,sample_count,next_predictor,next_index}`. The payload chunks are raw *headerless* IMA ADPCM (high nibble decoded first), base64 encoded; they are **not** WAV chunks. One decoded sample is represented by each nibble. A new watch response initializes predictor/index to zero, and multiple sentences preserve their predictor/index by supplying the previous response's `next_predictor` and `next_index` on the next `tts_prepare` call. Each encoded response pads an odd final PCM sample to a complete byte. The watch must select `SpeakerPcmFormat_16kHz_16bit` after decoding. The legacy direct Home Assistant mode still uses 8 kHz ADPCM, so consumers need to switch speaker formats according to the response source.

If an older consumer still expects WAV from this plugin, update that consumer before installing this release.
