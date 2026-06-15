# Voxout API Field Mapping

本文档基于当前代码实现和各 provider 官方文档整理。`provider` 是 Voxout 的路由扩展字段，不属于 OpenAI 官方 audio API。表格中的 `Default` 表示默认 provider：当前仅提供 Edge TTS。

Voxout 自身的外部参数、provider 配置字段、capabilities 字段，以及 service 到 provider adapter 的内部 request/response 字段默认使用 snake_case。provider adapter 最后一跳会按上游官方接口要求转换字段名；例如 Edge TTS 的 SDK 参数仍会映射为其要求的 `outputFormat`。

## 资料来源

各接口表格的 `OpenAI 规范` 和 provider 表头已内联链接到对应官方文档；没有官方对应接口的 Voxout 扩展表格会链接到 provider 最接近的 API 文档。

## Provider 配置通用字段

| 实际传参 | [OpenAI 规范][openai-api] | [OpenAI][openai-api] | [ElevenLabs][elevenlabs-api] | [Cartesia][cartesia-api] | [Gradium][gradium-api] | [MiMo][mimo-chat-api] | Default | 接受的透传参数 |
|---|---|---|---|---|---|---|---|---|
| `account_id` | 无 | 仅用于 Voxout voice 关联表 | 同左 | 同左 | 同左 | 同左 | 同左 | 不下发给 provider |
| `timeout_ms` | 无 | Voxout 调用超时 | Voxout 调用超时 | Voxout 调用超时 | HTTP 调用超时；WebSocket 流也使用该超时 | HTTP 调用和下载超时 | Edge TTS `timeout`；voice catalog 下载超时另用 `voices_timeout_ms` | 不下发，除 Default/Edge 映射到库参数 |

## POST `/v1/audio/speech`

生成语音。请求体是 JSON。非流式返回音频 bytes；`stream_format` 存在时返回音频流或 SSE。

| 实际传参 | [OpenAI 规范][openai-speech] | [OpenAI][openai-speech] | [ElevenLabs][elevenlabs-tts] | [Cartesia][cartesia-tts] | [Gradium][gradium-tts-rest] | [MiMo][mimo-tts] | Default | 接受的透传参数 |
|---|---|---|---|---|---|---|---|---|
| `model`，必填，除非 `provider` 显式指定 | 必填；官方 speech model | `model` | `model_id`，默认 `tts_model` 或 `eleven_multilingual_v2` | `model_id`，默认 `tts_model` 或 `sonic-3.5` | `model_name`，默认 `tts_model` 或 `default` | `model`，默认 `tts_model` 或 `mimo-v2.5-tts`；data URL voice 时改用 `voice_clone_model` | 不使用 | 无 |
| `provider`，可选 | 无 | 只用于路由；省略时 OpenAI model 或未知 model 路由到 OpenAI | 只用于路由 | 只用于路由 | 只用于路由 | 只用于路由 | 只用于路由 | 无 |
| `input`，必填 string | 必填；最大 4096 字符 | `input` | `text` | `transcript` | `text` | `messages[].content`，role 为 `assistant` | SSML 文本 | 无 |
| `voice`，可选 string 或 `{ id }` | 官方支持内置 voice string 和 custom voice object `{ id }` | `voice` | path `:voice_id` | `voice: { mode: "id", id }` | `voice_id` | `audio.voice`；若是 data URL，走 voice clone model | Edge `voice` | 无；若传 Voxout voice id，会先解析为对应 provider voice id |
| `response_format`，可选 | `mp3`、`opus`、`aac`、`flac`、`wav`、`pcm` | 原样 `response_format` | query `output_format`；`mp3 -> mp3_44100_128`，`pcm -> pcm_44100`，`wav -> pcm_44100` 后由 Voxout 包 WAV | `output_format` object；`mp3/wav/pcm` 转 Cartesia container/encoding | `output_format`；支持 `opus/wav/pcm` 等 Gradium 格式 | `audio.format`；`mp3/wav/pcm16` | Edge `outputFormat`；`mp3/wav/pcm` 转 Edge 格式 | 无 |
| `speed`，可选 number | 官方 `0.25..4.0` | 校验后作为 `speed` | 校验后映射 `voice_settings.speed`，按 ElevenLabs 范围 `0.7..1.2` 钳制 | 校验后映射 `generation_config.speed` | 当前忽略 | 当前忽略 | 转 Edge prosody `rate` | 无 |
| `instructions`，可选 string | 语音风格控制；不适用于 `tts-1` / `tts-1-hd`；最大 4096 字符 | 仅支持模型下发；`tts-1` / `tts-1-hd` 过滤 | 当前忽略 | 当前忽略 | 当前忽略 | 加入 `messages` 的 user prompt | 当前忽略 | 无 |
| `stream_format`，可选 `audio` 或 `sse` | 官方 `audio` / `sse`；`sse` 不适用于 `tts-1` / `tts-1-hd` | `stream_format`；`tts-1` / `tts-1-hd` + `sse` 在上游前拒绝 | 只支持 `audio`；`sse` 报错 | 调用 `/tts/sse`；`sse` 原样返回，`audio` 解码 SSE 音频 | WebSocket；`sse` 报错 | 下游 `stream: true`；`sse` 原样返回，`audio` 解码 SSE 音频 | WebSocket；`sse` 由 Voxout 包装 | 无 |
| `extra_params`，可选 object | 无 | 深合并到 OpenAI JSON body；不能包含 `model/input/voice/response_format/speed/instructions/stream_format` 等已识别请求字段 | 深合并到 ElevenLabs JSON body，可补充 `voice_settings` 等嵌套字段 | 深合并到 Cartesia JSON body | 深合并到 Gradium REST/WebSocket setup JSON body | 深合并到 MiMo chat completion JSON body | 当前不使用 | 仅接受 JSON object；不能覆盖已识别请求字段；未知 provider 参数由 adapter 最后一跳合并 |
| 响应 | 音频 bytes 或事件流 | 音频 bytes / OpenAI SSE | 音频 bytes / stream bytes | 音频 bytes / Cartesia SSE 或解码音频流 | 音频 bytes / WebSocket 音频流 | 音频 bytes / MiMo SSE 或解码音频流 | 音频 bytes / WebSocket 音频流 | 不返回 provider 原始 JSON；必要时 Voxout 做 `pcm <-> wav` 简单转换 |

## POST `/v1/audio/transcriptions`

语音转文字。请求体是 `multipart/form-data`。为贴近 OpenAI 规范，当前只接受 `file` 输入；旧的远程 URL、data URL、MIME 覆盖字段不再作为该接口入参。

| 实际传参 | [OpenAI 规范][openai-transcription] | [OpenAI][openai-transcription] | [ElevenLabs][elevenlabs-stt] | [Cartesia][cartesia-stt] | [Gradium][gradium-stt] | [MiMo][mimo-asr] | Default | 接受的透传参数 |
|---|---|---|---|---|---|---|---|---|
| `file`，必填 file | 官方必填 `file`，支持常见音频格式 | `file` | `file` | `file` | request body bytes | 内部转 data URL 放入 `input_audio.data` | 不支持 | 无 |
| `model`，必填，除非 `provider` 显式指定 | 官方 ASR model | `model` | `model_id`，默认 `asr_model` 或 `scribe_v2` | `model`，默认 `asr_model` 或 `ink-whisper` | query `model`，默认 `asr_model` 或 `default` | `model`，默认 `asr_model` 或 `mimo-v2.5-asr` | 不支持 | 无 |
| `provider`，可选 | 无 | 只用于路由；省略时 OpenAI ASR model 或未知 model 路由到 OpenAI | 只用于路由 | 只用于路由 | 只用于路由 | 只用于路由 | 不支持 | 无 |
| `language`，可选 string | ISO-639-1 | `language` | `language_code` | `language`，裁剪地区码 | `json_config={"language":...}`，裁剪地区码 | `asr_options.language`，默认 `auto` | 不支持 | 无 |
| `prompt`，可选 string | 引导转写风格；部分模型不支持 | `prompt`；`gpt-4o-transcribe-diarize` 在上游前拒绝 | 忽略 | 忽略 | 忽略 | 忽略 | 不支持 | 无 |
| `response_format`，可选 | `json`、`text`、`srt`、`verbose_json`、`vtt`、`diarized_json`；非法值拒绝；部分模型有子集限制 | 原样传给 OpenAI；`gpt-4o-transcribe*` 非 diarize 仅允许 `json`；diarize 仅允许 `json/text/diarized_json`；`whisper-1` 不允许 `diarized_json` | 非 `json/text` 会让 Voxout 请求 verbose 语义并本地格式化 | 同 ElevenLabs；Cartesia 固定请求 word timestamps | 同 ElevenLabs；结果由 Voxout 解析 | 同 ElevenLabs；当前无 segments | 不支持 | 无 |
| `stream`，可选 boolean | 官方支持 `stream=true` 返回 SSE transcript events；非法 boolean 拒绝；`whisper-1` 不支持 | `stream=true`，直接透传 OpenAI SSE；`whisper-1` 在上游前拒绝 | 不支持 | 不支持 | 不支持 | 下游 `stream: true`，Voxout 将 chat completion chunk 转成 `transcript.text.delta/done` SSE | 不支持 | 无 |
| `temperature`，可选 number | 官方 `0..1` | 校验后作为 `temperature` | 当前忽略 | 当前忽略 | 当前忽略 | 当前忽略 | 不支持 | 无 |
| `timestamp_granularities[]`，可选 array | `word` / `segment`；要求 `response_format=verbose_json`；diarize 不支持 | 重复 multipart 字段 `timestamp_granularities[]`；`gpt-4o-transcribe-diarize` 在上游前拒绝 | 当前忽略 | 当前忽略；仍固定发送 `timestamp_granularities[]=word` 以获得 words | 当前忽略 | 当前忽略 | 不支持 | 无 |
| `include[]`，可选 array | 当前支持 `logprobs`；只支持 `response_format=json` 且只支持 `gpt-4o-transcribe` / mini；diarize 不支持 | 重复 multipart 字段 `include[]`；不满足模型和格式约束时在上游前拒绝 | 当前忽略 | 当前忽略 | 当前忽略 | 当前忽略 | 不支持 | 无 |
| `chunking_strategy`，可选 `auto` 或 object | 官方 `auto` 或 server VAD object | `auto` 原样；object 以 JSON 字符串放入 multipart | 当前忽略 | 当前忽略 | 当前忽略 | 当前忽略 | 不支持 | 无 |
| `known_speaker_names[]` / `known_speaker_references[]`，可选 array | diarization 已知说话人名称和参考音频 data URL | 重复 multipart 字段 | 当前忽略 | 当前忽略 | 当前忽略 | 当前忽略 | 不支持 | 无 |
| `extra_params`，可选 JSON string | 无 | 追加到 OpenAI multipart；scalar 用原 key，array 用 `key[]` 重复字段，object JSON.stringify；不能覆盖已识别标准字段 | 当前不下发 multipart 额外字段 | 当前不下发 multipart 额外字段 | 当前不下发 multipart 额外字段 | 深合并到 MiMo chat completion JSON body | 不支持 | multipart 中必须是 JSON object 字符串；不能包含 `model/file/language/prompt/response_format/stream/temperature/timestamp_granularities/include/chunking_strategy/known_speaker_*` 等已识别字段 |
| 响应 | `json -> { text, ... }`；`text/srt/vtt` 返回文本；详细格式返回 JSON；`stream=true` 返回 SSE | JSON 会保留 OpenAI 原始 `logprobs/usage` 等字段；stream 直接透传 | Voxout 输出 `{ text }` / text / `{ text, segments, raw }` | 同 ElevenLabs | 同 ElevenLabs | 非流式同 ElevenLabs；stream 输出 OpenAI transcript SSE | 不支持 | 不直接返回未整理 provider 原始响应，除 OpenAI JSON 扩展字段或 verbose/diarized 中的 `raw` |

## POST `/v1/audio/effect`

生成音效。请求体是 JSON。OpenAI 官方当前没有对应的 `/v1/audio/effect` 规范；这是 Voxout 扩展接口。

| 实际传参 | OpenAI 规范 | OpenAI | [ElevenLabs][elevenlabs-sfx] | Cartesia | Gradium | MiMo | Default | 接受的透传参数 |
|---|---|---|---|---|---|---|---|---|
| `provider`，必填 | 无 | 不支持 | 只用于路由 | 不支持 | 不支持 | 不支持 | 不支持 | 无 |
| `input`，必填 string | 无 | 不支持 | `text` | 不支持 | 不支持 | 不支持 | 不支持 | 无 |
| `model`，可选 string | 无 | 不支持 | `model_id`，默认 `sound_effect_model` 或 `model` 或 `eleven_text_to_sound_v2` | 不支持 | 不支持 | 不支持 | 不支持 | 无 |
| `response_format`，可选 string | 无 | 不支持 | query `output_format`，默认 `output_format` 或 `mp3_44100_128` | 不支持 | 不支持 | 不支持 | 不支持 | 无 |
| `duration_seconds`，可选 number | 无 | 不支持 | 校验 `0.5..30` 后映射 `duration_seconds` | 不支持 | 不支持 | 不支持 | 不支持 | 无 |
| `prompt_influence`，可选 number | 无 | 不支持 | 校验 `0..1` 后映射 `prompt_influence` | 不支持 | 不支持 | 不支持 | 不支持 | 无 |
| `loop`，可选 boolean | 无 | 不支持 | `loop` | 不支持 | 不支持 | 不支持 | 不支持 | 无 |
| `extra_params`，可选 object | 无 | 不支持 | 深合并到 ElevenLabs sound generation JSON body | 不支持 | 不支持 | 不支持 | 不支持 | 仅接受 JSON object；不能包含 `provider/model/input/response_format/duration_seconds/prompt_influence/loop` 等已识别字段 |
| 响应 | 无 | 不支持 | 音频 bytes，MIME 来自 `content-type`，缺省 `audio/mpeg` | 不支持 | 不支持 | 不支持 | 不支持 | 不返回 ElevenLabs JSON |

## POST `/v1/audio/isolation`

人声/音频隔离。请求体是 `multipart/form-data`。OpenAI 官方当前没有对应的 `/v1/audio/isolation` 规范；这是 Voxout 扩展接口。为保持音频上传接口一致，当前只接受 `file` 输入；旧的远程 URL、data URL、MIME 覆盖字段不再作为该接口入参。

| 实际传参 | OpenAI 规范 | OpenAI | [ElevenLabs][elevenlabs-isolation] | Cartesia | Gradium | MiMo | Default | 接受的透传参数 |
|---|---|---|---|---|---|---|---|---|
| `provider` 或 `model`，必填其一 | 无 | 不支持 | 只用于路由 | 不支持 | 不支持 | 不支持 | 不支持 | 无 |
| `file`，必填 file | 无 | 不支持 | Voxout provider 内部映射成 ElevenLabs `audio` multipart file | 不支持 | 不支持 | 不支持 | 不支持 | 无 |
| `file_format`，可选 `pcm_s16le_16` 或 `other` | 无 | 不支持 | 校验后映射 `file_format`，缺省 `other` | 不支持 | 不支持 | 不支持 | 不支持 | 无 |
| `preview_b64`，可选 string | 无 | 不支持 | `preview_b64` | 不支持 | 不支持 | 不支持 | 不支持 | 无 |
| 响应 | 无 | 不支持 | 隔离后的音频 bytes，MIME 来自 `content-type`，缺省输入 MIME | 不支持 | 不支持 | 不支持 | 不支持 | 不返回 ElevenLabs JSON |

## POST `/v1/audio/design`

通过文本描述设计声音。请求体是 JSON。OpenAI 官方当前没有对应的 `/v1/audio/design` 规范；这是 Voxout 扩展接口。

| 实际传参 | OpenAI 规范 | OpenAI | [ElevenLabs][elevenlabs-design] | Cartesia | Gradium | [MiMo][mimo-tts] | Default | 接受的透传参数 |
|---|---|---|---|---|---|---|---|---|
| `provider`，必填 | 无 | 不支持 | 只用于路由 | 不支持 | 不支持 | 只用于路由 | 不支持 | 无 |
| `input`，必填 string | 无 | 不支持 | `voice_description` | 不支持 | 不支持 | voice description prompt | 不支持 | 无 |
| `name`，可选 string | 无 | 不支持 | 仅用于保存 Voxout voice 名称，不发送给设计接口 | 不支持 | 不支持 | 用于保存 Voxout voice 名称 | 不支持 | 无 |
| `text`，可选 string | 无 | 不支持 | `text` | 不支持 | 不支持 | sample text；缺省 `voice_sample_text` 配置或内置中文样例 | 不支持 | 无 |
| `response_format`，可选 string | 无 | 不支持 | query `output_format` | 不支持 | 不支持 | 预览固定 `wav` | 不支持 | 无 |
| `model`，可选 string | 无 | 不支持 | `model_id` | 不支持 | 不支持 | 当前不直接传入设计请求；使用 provider 配置 `voice_design_model` | 不支持 | 无 |
| `extra_params`，可选 object | 无 | 不支持 | 深合并到 ElevenLabs voice design JSON body；常用 `auto_generate_text`、`loudness`、`seed`、`guidance_scale`、`quality`、`reference_audio_base64`、`prompt_strength` | 不支持 | 不支持 | 深合并到 MiMo voice preview chat completion JSON body | 不支持 | 仅接受 JSON object；不能包含 `provider/input/name/text/response_format/model` 等已识别字段 |
| 响应 | 无 | 不支持 | Voxout 持久化 previews 为 voice records | 不支持 | 不支持 | Voxout 生成本地 `mimo_*` voice 并保存 preview | 不支持 | 不直接返回下游原始 previews，除非写入 metadata |

## POST `/v1/audio/voices`

上传音频素材克隆声音。请求体是 `multipart/form-data`。

| 实际传参 | [OpenAI 规范][openai-voice] | [OpenAI][openai-voice] | [ElevenLabs][elevenlabs-ivc] | [Cartesia][cartesia-clone] | [Gradium][gradium-clone] | [MiMo][mimo-tts] | Default | 接受的透传参数 |
|---|---|---|---|---|---|---|---|---|
| `provider`，可选，缺省 `openai` | 无 | 只用于路由 | 只用于路由 | 只用于路由 | 只用于路由 | 只用于路由 | 不支持 | 无 |
| `name`，必填 string | 必填 | `name` | `name` | `name` | `name` | 本地保存 name | 不支持 | 无 |
| `consent`，可选 string | 官方要求 consent recording id | `consent` | 忽略 | 忽略 | 忽略 | 忽略 | 不支持 | 无 |
| `audio_sample`，必填 file | 必填；最大 10 MiB，支持常见音频格式 | `audio_sample` | `files[]` | `clip` | `audio_file` | 不调用下游，仅保存为 preview audio | 不支持 | 无 |
| `description` / `language`，可选 string | OpenAI 无 | 保存到 Voxout voice record；不发送给 OpenAI voice clone | `description` 会发送；`language` 保存到 Voxout voice record | `description` / `language` 会发送；`language` 裁剪地区码，缺省 `en` | `description` / `language` 会发送；`language` 裁剪地区码 | 保存到 Voxout voice record；不调用下游 | 不支持 | 无 |
| `metadata`，可选 JSON object string | OpenAI 无 | 保存到 Voxout voice record；不发送给 provider | 同左 | 同左 | 同左 | 同左 | 不支持 | multipart 中必须是 JSON object 字符串 |
| `preview_text`，可选 string | OpenAI 无 | 保存到 Voxout voice metadata；不发送给 provider | 同左 | 同左 | 同左 | 同左 | 不支持 | 无 |
| 固定/配置字段 | 无 | 无 | 无 | `base_voice_id` 来自 provider 配置 `base_voice_id` | `input_format` 由 MIME 推断；`start_s=0`；`timeout_s` 来自 `clone_timeout_seconds` 或 `10` | 本地生成 `mimo_*` voice id | 不支持 | 无 |
| 响应 | `{ id, object: "audio.voice", created_at, name }` | Voxout 返回 OpenAI 风格响应，并保存 provider link | 同 OpenAI 风格响应 | 同 OpenAI 风格响应 | 同 OpenAI 风格响应 | 同 OpenAI 风格响应；无 provider voice id | 不支持 | 不返回 provider 原始 clone response |

## GET `/v1/models`

| 实际传参 | [OpenAI 规范][openai-models] | [OpenAI][openai-models] | [ElevenLabs][elevenlabs-api] | [Cartesia][cartesia-api] | [Gradium][gradium-api] | [MiMo][mimo-rate-limit] | Default | 接受的透传参数 |
|---|---|---|---|---|---|---|---|---|
| 无 | OpenAI list models 返回 `{ object: "list", data: [...] }` | 聚合为 model object | 聚合为 model object | 聚合为 model object | 聚合为 model object | 聚合为 model object | 聚合为 model object | 无 |
| 响应 | 官方 model object 更丰富 | `id=openai`，带 capabilities | `id=elevenlabs` | `id=cartesia` | `id=gradium` | `id=mimo` | `id=default`，仅 TTS capabilities | 返回 `{ object: "list", data: [{ id, object, created, owned_by, capabilities }] }` |

## GET `/api/providers`

| 实际传参 | OpenAI 规范 | [OpenAI][openai-api] | [ElevenLabs][elevenlabs-api] | [Cartesia][cartesia-api] | [Gradium][gradium-api] | [MiMo][mimo-chat-api] | Default | 接受的透传参数 |
|---|---|---|---|---|---|---|---|---|
| 无 | 无 | 返回 provider 定义、fields、enabled、configured | 同左 | 同左 | 同左 | 同左 | 同左 | 无 |
| 响应 | 无 | secrets 被 mask | secrets 被 mask | secrets 被 mask | secrets 被 mask | secrets 被 mask | secrets 被 mask | 内部测试 provider 默认不返回 |

## PUT `/api/providers/:provider_id/config`

| 实际传参 | OpenAI 规范 | [OpenAI][openai-api] | [ElevenLabs][elevenlabs-api] | [Cartesia][cartesia-api] | [Gradium][gradium-api] | [MiMo][mimo-chat-api] | Default | 接受的透传参数 |
|---|---|---|---|---|---|---|---|---|
| `enabled` | 无 | 启停 provider | 同左 | 同左 | 同左 | 同左 | 同左 | 无 |
| `secrets.api_key` | 无 | `Authorization: Bearer` | `xi-api-key` | `Authorization: Bearer` | `x-api-key` | `api-key` 和 `Authorization: Bearer` | 不使用；Edge 可配置 `trusted_client_token` | 仅 provider 读取的 secret 会下发 |
| `config.base_url` | 无 | OpenAI API base URL | ElevenLabs API base URL | Cartesia API base URL | Gradium REST base URL | MiMo base URL | 不使用 | 未读取字段会保存但不会下发 |
| `config.tts_model` / `config.asr_model` | 无 | TTS/ASR 默认模型 | TTS/ASR 默认模型 | TTS/ASR 默认模型 | TTS/ASR 默认模型 | TTS/ASR 默认模型 | ASR/TTS 不使用 | 未读取字段会保存但不会下发 |
| provider 专属配置 | 无 | `default_voice`、`response_format` | `default_voice_id`、`output_format`、`sound_effect_model`、`voice_design_model`、`prompt_influence` | `api_version`、`default_voice_id`、`output_format`、`base_voice_id`、`pronunciation_dict_id` | `ws_url`、`default_voice_id`、`output_format`、`clone_timeout_seconds` | `voice_design_model`、`voice_clone_model`、`format`、`voice_sample_text`、`optimize_text_preview` | `voices_url`、`trusted_client_token`、`proxy`、`voices_cache_ms`、`voices_timeout_ms` | `config` / `secrets` 可保存任意 JSON object；未读取字段不下发 |
| 响应 | 无 | `{ provider: record }` | 同左 | 同左 | 同左 | 同左 | 同左 | 无 |

## GET `/api/voices` 和 `/api/providers/:provider_id/voices`

| 实际传参 | OpenAI 规范 | [OpenAI][openai-voice] | [ElevenLabs][elevenlabs-voices] | [Cartesia][cartesia-voices] | [Gradium][gradium-clone] | [MiMo][mimo-tts] | Default | 接受的透传参数 |
|---|---|---|---|---|---|---|---|---|
| `/api/voices?provider=...` 可选 provider | 无 | 过滤 Voxout 持久化 voices | 同左 | 同左 | 同左 | 同左 | 同左 | 无 |
| `/api/providers/:provider_id/voices` 必填 provider path | 无 | 内置 OpenAI voices + 持久化 voices | 请求 ElevenLabs `/v2/voices` + 持久化 voices | 请求 Cartesia `/voices` + 持久化 voices | 请求 Gradium `/voices/` + 持久化 voices | 内置 MiMo voices + 持久化 voices | 请求 Edge voice catalog + 持久化 voices | 无 |
| 响应 | 无 | `{ voices }` | `{ voices }` | `{ voices }` | `{ voices }` | `{ voices }` | `{ voices }` | `/api/voices` 返回 voice records；provider voices 返回 `TtsVoice[]` |

## Provider 特别说明

| 实际传参 | [OpenAI 规范][openai-api] | [OpenAI][openai-api] | [ElevenLabs][elevenlabs-api] | [Cartesia][cartesia-api] | [Gradium][gradium-api] | [MiMo][mimo-chat-api] | Default | 接受的透传参数 |
|---|---|---|---|---|---|---|---|---|
| Default provider | 无 | 不适用 | 不适用 | 不适用 | 不适用 | 不适用 | TTS 实际是 Edge TTS；不再注册 ASR capability。 | 无 |
| OpenAI `voice` object `{ id }` | 官方支持 | Voxout 会把 `{ id }` 规范化为内部 string voice，并继续执行 provider voice 关联解析 | 不适用 | 不适用 | 不适用 | 不适用 | 不适用 | 无 |
| OpenAI transcription streaming | 官方 `stream=true` | OpenAI 直接透传 SSE；MiMo 转成 OpenAI transcript SSE；其他 provider 不支持 | 不适用 | 不适用 | 不适用 | 不适用 | 不适用 | 无 |

[openai-api]: https://developers.openai.com/api/reference
[openai-speech]: https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
[openai-transcription]: https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
[openai-voice]: https://developers.openai.com/api/reference/resources/audio/subresources/voices/methods/create
[openai-models]: https://developers.openai.com/api/reference/models/list
[elevenlabs-api]: https://elevenlabs.io/docs/api-reference
[elevenlabs-tts]: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
[elevenlabs-stt]: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
[elevenlabs-sfx]: https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert
[elevenlabs-design]: https://elevenlabs.io/docs/api-reference/text-to-voice/design
[elevenlabs-ivc]: https://elevenlabs.io/docs/api-reference/voices/ivc/create
[elevenlabs-isolation]: https://elevenlabs.io/docs/api-reference/audio-isolation/convert
[elevenlabs-voices]: https://elevenlabs.io/docs/api-reference/voices/search
[cartesia-api]: https://docs.cartesia.ai/api-reference
[cartesia-tts]: https://docs.cartesia.ai/api-reference/tts/bytes
[cartesia-stt]: https://docs.cartesia.ai/api-reference/stt/transcribe
[cartesia-clone]: https://docs.cartesia.ai/api-reference/voices/clone
[cartesia-voices]: https://docs.cartesia.ai/api-reference/voices/list
[gradium-api]: https://docs.gradium.ai/api-reference
[gradium-tts-rest]: https://docs.gradium.ai/api-reference/endpoint/tts-post
[gradium-stt]: https://docs.gradium.ai/api-reference/endpoint/stt-post
[gradium-clone]: https://docs.gradium.ai/api-reference/endpoint/create-voice
[mimo-chat-api]: https://mimo.mi.com/docs/en-US/api/chat/openai-api
[mimo-asr]: https://mimo.mi.com/docs/en-US/api/audio/Speech-Recognition
[mimo-tts]: https://mimo.mi.com/docs/en-US/usage-guide/speech-synthesis-v2.5
[mimo-rate-limit]: https://mimo.mi.com/docs/zh-CN/api/guidance/rate-limit
