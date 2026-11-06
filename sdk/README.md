# Pebble Home Assistant Bridge — reusable audio SDK

**SDK v1** · Works with Home Assistant Bridge plugin **v0.2.20 or newer**.

The Bridge owns **Home Assistant configuration, authentication, TTS generation, resampling, PCM WAV checksums, and temporary WAV sessions**. The consuming app owns its PebbleKit JS → Bluetooth AppMessage transport and the watch's native speaker. A plugin cannot directly include native C code into another watch app or write that app's speaker stream.

Copy these **three small, versioned files** into an app:

| Bridge SDK source | App destination | Purpose |
| --- | --- | --- |
| [ha_audio.js](./ha_audio.js) | `src/pkjs/ha_audio.js` | Plugin audio, checksums, ADPCM, bounded rolling chunk transfers, next-sentence prefetch, BLE pacing |
| [ha_audio.c](./ha_audio.c) | `src/c/ha_audio.c` | Watch ADPCM decoder, 16-KiB ring, double PCM frame buffers, speaker stream, diagnostics |
| [ha_audio.h](./ha_audio.h) | `src/c/ha_audio.h` | Watch interface |

**Important:** Use the **same SDK version on the phone and watch**. For repeatable builds, pin an actual Git commit, not the `main` branch, when copying these files.

## 1. App manifest

Add to `pebble.messageKeys`:

```json
["COMMAND", "TEXT", "CHUNK"]
```

If the app already has these names, do not add them again. The library uses the existing keys. Add to `pebble.usesPermissions` (preserve existing entries):

```json
[
  {"name":"HomeConverse","plugin":"a74370b6-929c-4ec0-b7ee-2fc6fca8db57"},
  {"name":"InvokeAction","plugin":"a74370b6-929c-4ec0-b7ee-2fc6fca8db57"}
]
```

Target a Pebble with a speaker (`PBL_SPEAKER`). On a watch without one, the watch-side module builds as no-op functions. The app must open AppMessage with an inbox large enough for the 700-byte audio chunk (recommended: `app_message_open(12000,1024)`).

## 2. Phone `src/pkjs/index.js`

```javascript
var audio = require('./ha_audio').create({
  Pebble: Pebble,
  storage: localStorage,
  onComplete: function() { console.log('Audio data sent'); },
  onError: function(e) { console.log('Speech error: '+e.message); },
  onStats: function(stats) { console.log('Watch speaker stats '+JSON.stringify(stats)); }
});

// This library speaks text; you can get text from the Bridge's conversation
// action or use any text already available to your app.
audio.speak('The garage door is closed.').catch(function(e) {
  console.log('Could not start audio: '+e.message);
});

// Route telemetry through your existing appmessage handler.
Pebble.addEventListener('appmessage', function(e) {
  if(audio.handleMessage(e.payload))return;
  // Handle your other application messages here.
});

// For cancellations or when a new voice interaction starts:
// audio.stop();
```

`audio.speak(text)` returns a Promise when the watch has acknowledged **AUDIO_RESET** and the producer has started. It does **not** wait for speaker playback to finish. `onComplete` means that the phone has **sent all audio**. The watch may still have queued PCM. Use `onStats` to observe the final speaker session after it closes.

The module intentionally does not read a Home Assistant URL or token. Authentication remains in the Bridge's secure storage. The Bridge uses its configured TTS engine. No separate app-level TTS engine setup is required.

## 3. Watch `src/c/main.c`

```c
#include <pebble.h>
#include "ha_audio.h"

static void inbox_received(DictionaryIterator *iterator, void *context) {
  if(ha_audio_handle_message(iterator))return;
  // Existing non-audio application commands here.
}

static void setup(void) {
  ha_audio_init();
  app_message_register_inbox_received(inbox_received);
  app_message_open(12000, 1024);
}

static void teardown(void) {
  ha_audio_deinit();
}
```

The app must register **one** inbox callback; do not register a separate handler in the library. Initialize the library before accepting audio messages. Use `ha_audio_set_volume(0.7f)` for software volume, `ha_audio_is_playing()` for nonblocking status, and `ha_audio_stop()` for cancellation.

The library recognizes `AUDIO_RESET`, `AUDIO_CHUNK`, `AUDIO_SENTENCE_END`, and `AUDIO_STOP`. It sends one `AUDIO_STATS` message after the speaker closes, using `COMMAND` and `TEXT`.

## How it works

1. The app sends **AUDIO_RESET** to clear ADPCM state and any earlier playback.
2. The library invokes the Bridge's **tts_prepare** action with the first sentence. The Bridge generates 8 kHz, mono PCM16 WAV, provides an inlined verified first chunk, and saves subsequent chunks.
3. The library checks the first chunk, applies the same low-pass filter and stateful IMA-ADPCM encoding used by Home Assistant AI, then starts 700-byte AppMessage chunks without waiting for the whole WAV.
4. Up to three Bridge chunks are requested concurrently and decoded in order, with independent FNV-1a verification and a final whole-file checksum. Prefetch of the next sentence overlaps current playback after the first ~750 ms of audio has been queued.
5. The watch plays 8 kHz 16-bit PCM using a 16 KiB ADPCM ring and alternating PCM frames, with partial speaker writes retried. It begins after a 2,800-byte startup buffer (or after a short final sentence).
6. The phone sends **AUDIO_SENTENCE_END** only after the final chunk of each sentence; chunk boundaries are not sentence boundaries.

**Transport limitation:** Pebble's plugin-host `fetch()` exposes the complete HA WAV ArrayBuffer rather than an HTTP ReadableStream. Streaming here begins after **tts_prepare**, *during* the plugin-to-app transfer and before the full phone WAV arrives; it is not true upstream HTTP streaming.

## Failure behavior and troubleshooting

- Each transfer's WAV chunks must match the Bridge-provided checksums; missing or corrupted data stops playback rather than outputting static.
- The Bridge supports multiple temporary TTS sessions so preparing a following sentence does not expire the current one.
- Never drop an ADPCM chunk silently—the predictor is stateful.
- Use `audio.diagnostics()` for the latest Bridge TTS timing and full-file verification. Audio telemetry is emitted through `onStats`, including PCM-empty events, speaker partial writes and peak ADPCM ring occupancy.
- The installed Bridge must have a TTS engine configured and grant the consuming app its declared plugin permissions.
- **Regression tests:** `tests/test_audio_sdk.cjs` (phone), `tests/test_plugin.cjs` (Bridge). Watch C also requires an SDK build on a speaker-capable platform; native hardware playback remains a separate validation step.

## Compatibility and updates

These are reusable **source files**, not a globally installed JavaScript/C package. Pebble watch apps are independently compiled and must include their own watch speaker support. Future updates to the Bridge protocol can be distributed with a new SDK version; do not silently change packet formats without compatibility checks.

The proven Home Assistant AI app is the behavior reference for this SDK. It can be migrated to the shared files separately, after hardware validation, rather than risking the user's functioning playback baseline during the initial library extraction.
