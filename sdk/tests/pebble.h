/* Minimal Pebble API signatures for HOST SYNTAX TESTS ONLY.
 * Real watch builds must include the actual Pebble SDK pebble.h.
 */
#ifndef SDK_AUDIO_PEBBLE_TEST_STUB_H
#define SDK_AUDIO_PEBBLE_TEST_STUB_H
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
typedef struct AppTimer AppTimer;
typedef struct DictionaryIterator DictionaryIterator;
typedef struct {
  char *cstring;
  uint8_t *data;
} TupleValue;
typedef struct Tuple {
  uint8_t type;
  uint16_t length;
  TupleValue *value;
} Tuple;
enum {TUPLE_CSTRING=2,APP_MSG_OK=0,APP_LOG_LEVEL_ERROR=1};
enum {SpeakerPcmFormat_8kHz_16bit=0};
typedef int AppMessageResult;
typedef int SpeakerPcmFormat;
extern AppTimer *app_timer_register(uint32_t milliseconds,void (*callback)(void*),void *data);
extern void app_timer_cancel(AppTimer *timer);
extern AppMessageResult app_message_outbox_begin(DictionaryIterator **iter);
extern AppMessageResult app_message_outbox_send(void);
extern void dict_write_cstring(DictionaryIterator *iter,uint32_t key,const char *value);
extern Tuple *dict_find(DictionaryIterator *iter,uint32_t key);
extern bool speaker_stream_open(SpeakerPcmFormat format,uint32_t latency);
extern void speaker_stream_close(void);
extern uint32_t speaker_stream_write(const uint8_t *data,uint32_t length);
#define MESSAGE_KEY_COMMAND 0
#define MESSAGE_KEY_TEXT 1
#define MESSAGE_KEY_CHUNK 2
#define APP_LOG(level,format,...) ((void)0)
#endif
