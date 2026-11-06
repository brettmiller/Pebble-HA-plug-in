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
| `tts_prepare` | `{text, engine_id?}` | HomeConverse | Request mono PCM16 WAV from HA, normalize to canonical 8kHz PCM16 WAV for consumer-side encoding; optional `{predictor,index}` carry state across sentences. Returns session ID, byte count, codec metadata and `{next_predictor,next_index}` |
| `tts_chunk` | `{session_id, offset}` | HomeConverse | Return a base64 chunk of canonical 8kHz PCM16 WAV (up to 6000 bytes) |
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

The plugin exposes canonical 8 kHz mono PCM16 WAV audio through request-scoped, base64-encoded chunks. It validates the Home Assistant audio format and resamples when needed; the consuming phone app handles filtering and IMA ADPCM encoding, exactly as in Gemini.

## Watchapp compatibility

Home Assistant AI v0.2.x offers a **Use Home Assistant plugin** settings toggle. The plugin-backed path uses `conversation` for one-shot dictation, without copying the token into watchapp storage, and uses `tts_prepare` / `tts_chunk` for spoken responses when enabled. The `continuous-native-conversation` consumer branch reconstructs WAV, decodes signed PCM16, runs Gemini's 3-sample low-pass filter and IMA ADPCM encoder, and sends compressed bytes to the watch.

**Limitation:** Continuous watch microphone streaming is not yet supported in plugin mode. It requires a long-running binary Assist WebSocket; current plugin actions are request-scoped and expose no streaming bridge. The watchapp blocks this feature while plugin mode is selected rather than silently using direct credentials. One-shot watch dictation and text-to-speech responses use only the plugin. Plugin-owned audio sessions rely on the plugin preview runtime retaining an active handler instance across chunk requests and require testing on a physical phone/watch.

## Build

GitHub Actions: `.github/workflows/build-ha-plugin.yml` packages the plugin with a pinned version of Pebble's official `pack-plugin-pbw.py`. No SDK or local installation is necessary for the plugin-only package.

The Pebble plugin API is still evolving. Test updates using the current Pebble mobile app, and verify store submission requirements before publishing.


## Gemini-matched audio contract (v0.2.8)

This version keeps the proven Gemini division of responsibilities and adds transport integrity diagnostics. The plugin requests mono 8 kHz 16-bit PCM WAV (Home Assistant may choose its own supported output rate), validates the actual WAV payload, resamples to 8 kHz when necessary, then emits a canonical 44-byte WAV header and little-endian 16-bit PCM data. `tts_prepare` returns `{session_id,length,chunk_bytes,format:"pcm_s16le_wav",sample_rate:8000,channels:1,bits_per_sample:16,sample_count}`. `tts_chunk` returns base64-encoded sections of that *complete WAV file*. The phone app reconstructs the WAV, parses signed PCM16, applies Gemini's three-sample moving-average filter, encodes 4-bit IMA ADPCM high nibble first while maintaining predictor state between sentences, and sends 700-byte `AUDIO_CHUNK` messages to the watch. Pebble decodes the stream into signed 8 kHz 16-bit PCM and plays it through `SpeakerPcmFormat_8kHz_16bit`.

**Compatibility:** v0.2.5 and v0.2.6 produced ADPCM chunks; these are deliberately incompatible with the v0.2.7 PCM WAV client. Rebuild and install both sides. Older plug-ins cause a specific actionable bridge-version error rather than falling through to static audio.

### Diagnosing static (v0.2.8)

The plugin computes a 32-bit FNV-1a checksum of the complete normalized PCM WAV and publishes `wav_checksum` in `tts_prepare`. The watchapp validates the checksum after retrieving and assembling all base64 WAV chunks, **before** decoding PCM or encoding ADPCM. A mismatch stops playback with a clear error instead of sending corrupted speech to the watch. The Home Assistant AI app also adds **Test watch audio (440 Hz tone)** in its settings: saving this option sends a known waveform through the Gemini-equivalent phone encoder, BLE packet queue, watch ADPCM decoder and speaker, without invoking Home Assistant. If this tone is clean but spoken TTS is static, investigate the bridge WAV/PCM or actual TTS source. If the tone itself is static, investigate Bluetooth packet integrity, decoder state and speaker buffering. The tone test is explicitly user-triggered; normal speech remains fully routed through the bridge.

### v0.2.9 audio isolation

The bridge supports `tts_prepare({test_tone:true})`, which produces a 7-second 440 Hz, 8 kHz PCM16 WAV through the exact same temporary session, base64 chunk, checksum and phone-side ADPCM encoder used for Home Assistant speech. This reference is deliberately longer than the watch's 16 KiB compressed ring buffer to exercise sustained playback. A separate phone-generated 1.5-second tone only exercises the phone encoder and watch. `tts_prepare` now includes `audio_diagnostics` with source/output RMS, peak, clipped sample counts, zero crossings, duration, and the input sample rate for Home Assistant speech. No raw speech content is logged. In Home Assistant AI v0.2.4 choose **Test audio through bridge (440 Hz)** in settings, save, and compare with normal speech. Bridge tone clean + TTS distorted isolates provider audio or normalization; bridge tone distorted isolates bridge session/chunk/phone path or long-duration watch handling.
