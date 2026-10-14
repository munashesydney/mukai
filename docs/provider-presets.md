# Provider presets

Official API documentation checked October 13, 2026. The built-in catalog is in `src/shared/providerPresets.ts`. Users choose a preset and supply their own credentials; presets do not create authenticated connections or replace existing configurations.

All new compatible models start with a **32,768-token per-response cap**. This is an adjustable Mukai default, not the provider's advertised maximum. Custom compatible models start with a **128,000-token context window**, which users should adjust to the actual served model. Named presets use documented capacities; where documentation says only 1M or 256K, the catalog uses conservative decimal capacities of 1,000,000 and 256,000 tokens.

| Provider    | OpenAI-compatible base URL                               | Included model IDs                                                   | Context            | Documented output capacity                                                                  |
| ----------- | -------------------------------------------------------- | -------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| DeepSeek    | `https://api.deepseek.com`                               | `deepseek-flash`, `deepseek-v4-pro`                                  | 1M                 | 384K                                                                                        |
| Z.ai / GLM  | `https://api.z.ai/api/paas/v4`                           | `glm-5.3`, `glm-5.3-flash`, `glm-5.3-flashx`                         | 1M                 | 128K                                                                                        |
| Xiaomi MiMo | `https://api.xiaomimimo.com/v1`                          | `mimo-v2.6-pro`, `mimo-v2.6-flash`                                   | 1M                 | 128K                                                                                        |
| Qwen        | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen3.8-max`, `qwen3.8-flash`                                       | 1,000,000          | 131,072                                                                                     |
| Kimi        | `https://api.moonshot.ai/v1`                             | `kimi-k3`; `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k2.6` | K3: 1M; K2.x: 256K | Use the 32K Mukai cap; the linked model parameter reference does not list an output maximum |

## Official sources and endpoint details

- [DeepSeek model details](https://api-docs.deepseek.com/quick_start/pricing/): Flash supports images; Pro is text-only. Use `deepseek-flash`, the current ID, rather than retired Flash aliases.
- [Z.ai API introduction](https://docs.z.ai/api-reference/introduction), [GLM 5.3](https://docs.z.ai/guides/llm/glm-5.3), [GLM Flash / FlashX](https://docs.z.ai/guides/vlm/glm-5.3-flash): the standard API and Coding Plan use different endpoints. The latter is `https://api.z.ai/api/coding/paas/v4`; model access depends on the plan (FlashX is not currently included in the Coding Plan). GLM 5.3 is text-only; Flash and FlashX support images.
- [MiMo Pro](https://mimo.mi.com/models/en-US/mimo-v2.6-pro), [MiMo Flash](https://mimo.mi.com/models/en-US/mimo-v2.6-flash): both accept images. The preset uses pay-as-you-go; Token Plan subscriptions require their own key and endpoint.
- [Qwen OpenAI compatibility](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope), [regional endpoint migration](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-dashscope), [Qwen Max](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max), [Qwen Flash](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-flash): both models accept images. Keys are region-specific. The UI also offers Virginia (`https://dashscope-us.aliyuncs.com/compatible-mode/v1`) and Beijing (`https://dashscope.aliyuncs.com/compatible-mode/v1`). Singapore and Beijing legacy endpoints remain functional; users can enter the newer workspace-specific domains. Model availability depends on the selected region.
- [Kimi quickstart](https://platform.kimi.ai/docs/overview), [model list](https://platform.kimi.ai/docs/models), [parameter reference](https://platform.kimi.ai/docs/api/models-overview): all included models accept images. Kimi K2.5 and older K2/moonshot-v1 models are discontinued, so they are excluded from new presets. The official K2.6 example uses a 32K output cap. API access uses the Moonshot endpoint even though documentation now lives at platform.kimi.ai.

## Persistence and request behavior

Model edits use `PUT /providers/:id/models` and update only the saved models and default model. Connection names, URLs, encrypted credentials, and the default-provider selection are retained. Failed saves keep the editor open and its values intact. Changing or removing a default model updates the saved provider limits and capabilities from the new default.

The SDK carries `reasoning_content` through compatible-model tool calls. Request generation leaves sampling parameters unspecified, allowing the providers' required defaults. Long-context models honor the configured response cap while retaining at least half the context for input; small and unknown contexts retain the conservative output reserve. The built-in manual output setting currently supports up to 262,144 tokens, even where a provider advertises a higher capacity.

Keep this catalog current by rechecking the linked official sources. Existing saved provider/model settings are never overwritten by catalog updates.
