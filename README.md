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

The plugin still does not expose continuous microphone streaming or binary TTS audio. The consuming watchapp must implement that separately.

## Watchapp compatibility

Home Assistant AI v0.2.x offers a **Use Home Assistant plugin** settings toggle. The plugin-backed path uses `conversation` for one-shot dictation, without copying the token into watchapp storage, and currently displays the response as text.

**Limitation:** Native watch microphone streaming, Assist STT and audio TTS still use the existing direct Home Assistant connection. Pebble plugin actions are request-scoped and do not currently replace a long-running WebSocket and binary audio transport. Keep the direct setup for hands-free voice. Do not enable the plugin toggle expecting it to migrate that voice connection automatically.

## Build

GitHub Actions: `.github/workflows/build-ha-plugin.yml` packages the plugin with a pinned version of Pebble's official `pack-plugin-pbw.py`. No SDK or local installation is necessary for the plugin-only package.

The Pebble plugin API is still evolving. Test updates using the current Pebble mobile app, and verify store submission requirements before publishing.
