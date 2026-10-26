# Audio and video input

Model settings have independent image, audio-input, and video-input switches. Mukai sends supported media as SDK file parts with its verified MIME type; it does not silently replace audio with a transcript or video with sampled screenshots.

## Media tool

The former Image tool is now **Media**, with six actions:

| Action         | Result                                  |
| -------------- | --------------------------------------- |
| `read_image`   | Image metadata only                     |
| `view_image`   | Image pixels for the next model step    |
| `read_audio`   | Audio container type and byte size only |
| `listen_audio` | Original audio for the next model step  |
| `read_video`   | Video container type and byte size only |
| `view_video`   | Original video for the next model step  |

Each action takes exactly one `path`, `attachmentId`, or `artifactId`. Paths target the active local computer or VM; saved IDs are resolved by the host without a copy. Inspection requires that model input capability; metadata reads do not. `copy_attachment` preserves original bytes for images, audio, video and documents in both local and VM modes.

Inspection tool results carry file parts rather than base64 JSON. The transport places audio/video after the complete tool result group as model input. Context and transport limits update `mediaIncluded` and `mediaDelivery`; metadata reads report `metadata_only`. Container checks do not certify a codec or imply model comprehension. The tool does not produce a transcript, sample frames, fetch remote URLs or play media in the UI.

Capability failures, unavailable files, size limits and provider rejections return factual context. Notices contain what happened and whether content is present, with no instructions about what to tell the user. Existing Image assignments migrate to Media, including disabled assignments. Historical Image activity and image previews remain readable.

## Attachment handling

The initial formats are **PCM/float WAV, MP3, MP4, and MOV**, with the existing **10 MB per-file and four-attachment limits**. The file picker reflects the selected model. Container/signature checks reject empty, disguised, truncated, and audio-only video containers. Providers perform final codec, duration, and decoding validation, so a valid container is not a guarantee that a particular model can decode it.

New unsupported attachments are blocked before a chat turn is created, and pending uploads remain available when changing models. Historical unsupported attachments become a text notice identifying the media and its capability mismatch; no bytes or invented transcript are sent. Retrying with a different model uses the same policy. Switching back to a capable model restores the original bytes for history that remains in the model context. Missing media produces an explicit unavailable-content notice. Saved uploads are not changed by these conversions.

Context estimates treat media as media instead of counting base64 characters as prose. If required media cannot fit the current model input budget, its bytes become context notices so the model can explain the limitation. Compaction excludes binary audio/video payloads from its text summarization prompt and preserves only recorded observations and a media omission note. Changing input capabilities invalidates old model checkpoints.

When a provider rejects audio/video input or its request size before producing output or executing a tool in that step, Mukai retries once with the media bytes replaced by context notices. The model can explain the limitation and continue with the user's text. Notices never include raw provider errors or fabricated media descriptions. Completed tool steps and original stored attachments are preserved. Authentication, quota, and network errors are handled separately; an unsuccessful fallback remains a normal provider failure.

## Preset inputs checked October 25, 2026

| Preset models                        | Audio input | Video input | Official source                                                                                                                                                                                                                        |
| ------------------------------------ | ----------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DeepSeek Flash / V4 Pro              | No          | No          | [Model catalog](https://api-docs.deepseek.com/quick_start/pricing/) and [image-only vision API](https://api-docs.deepseek.com/guides/vision/)                                                                                          |
| GLM 5.3                              | No          | No          | [Text-only model](https://docs.z.ai/guides/llm/glm-5.3)                                                                                                                                                                                |
| GLM 5.3 Flash / FlashX               | No          | Yes         | [Input modalities](https://docs.z.ai/guides/vlm/glm-5.3-flash)                                                                                                                                                                         |
| MiMo V2.6 Pro / Flash                | Yes         | Yes         | [Audio input](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/audio-understanding), [video input](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/video-understanding) |
| Qwen 3.8 Max / Flash                 | No          | Yes         | [Max](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max), [Flash](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-flash)                                                                                         |
| Kimi K3, K2.7 Code / Highspeed, K2.6 | No          | Yes         | [Kimi vision input](https://platform.kimi.ai/docs/guide/use-kimi-vision-model)                                                                                                                                                         |

Old preset model records without the new flags inherit these catalog values. Explicit user settings, including `false`, take precedence; unknown custom models default to no audio/video input. Model limits, credentials, and existing image choices remain unchanged.

Google Gemini 2.0/2.5 and 3.x Pro/Flash language-model IDs default to audio/video input, excluding image-generation, TTS, live, and native-audio variants. These inputs use the [Google AI SDK adapter](https://ai-sdk.dev/providers/ai-sdk-providers/google). Other model IDs can be configured manually. OpenAI audio-enabled models use the SDK Chat Completions adapter; the existing Responses adapter remains in use for other OpenAI models. OpenAI video, ChatGPT subscription audio/video, and Anthropic audio/video are unavailable through Mukai's current adapters, so their controls are disabled.

Compatible endpoints receive `input_audio` (WAV/MP3) or `video_url` (inline data URL) parts through the installed SDK. MiMo's documented MIME-prefixed audio data URL is applied only to the recognized MiMo endpoint. No public upload URLs or externally hosted copies are created by Mukai.

Automated tests use a local mock provider to verify actual SDK serialization, persistence, capability changes, and errors; they do not make billable provider calls or certify every codec against live models.

Run `npm run test:media-ui` after `npm run build:web` for the browser check covering the file picker, blocked pending media, model changes, and media serialization.
