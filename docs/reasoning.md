# Reasoning effort

Each saved model can set a default reasoning effort. The effort picker beside the bot's model picker overrides that default for the bot, across its conversations. **Inherit** follows the saved model; **Provider default** explicitly omits effort/thinking controls. A running turn retains the settings resolved at its start, including retries and tool steps. Settings changes apply to later turns. Memory extraction and context compaction use their own policies.

Models saved before this feature retain their former implicit policy when `reasoningEffort` is absent: medium for matching OpenAI models, adaptive or 2,048 thinking tokens for matching Claude models, and provider defaults elsewhere. Newly added models in the UI, presets, and account discovery start with explicit `provider-default`. Older API clients may continue omitting this field to retain the former policy. Bot null means inherit. Changing the bot's provider/model clears its override unless an override is explicitly submitted.

## Capabilities and adapters

`src/shared/reasoning.ts` supplies endpoint/model-scoped capabilities to both the UI and server. Unknown models expose only provider-default. For custom compatible endpoints, the model editor can explicitly declare the values accepted in `reasoning_effort`. Known provider profiles cannot be overridden by a custom declaration. Account discovery preserves recognized advertised effort levels when supplied; otherwise conservative model-family profiles apply. Do not import undocumented SDK internals as a capability API.

Mukai uses direct Vercel AI SDK adapters, without requiring AI Gateway. With installed `ai@7.0.127`, shared reasoning supports provider-default through xhigh. Native provider options carry max, which the installed shared type does not include. SDK mappings handle OpenAI and adaptive Claude effort, Gemini thinking levels, and disabled thinking where supported. Native options handle compatible endpoints' thinking switches, effort fields, and budgets. The UI labels on/off-only models as Off / Thinking on rather than promising variable effort.

For manual Claude thinking, the adapter adds its thinking budget to `maxOutputTokens`. Existing fixed budgets are reserved in the context manager. Explicit low/medium/high allocate 10%/30%/60% of the total allowance (minimum 1,024 thinking tokens, maximum 32,768), leaving at least 256 tokens for the response; the total sent to the API stays within the allowance. Gemini 2.5 and Qwen budgets also use percentages of Mukai's allowance rather than the SDK's model-maximum-derived budget. SDK compatibility warnings concerning reasoning are recorded as sanitized diagnostics, without raw request content.

## Sources

Profiles checked October 26, 2026. Update capabilities and serialization tests together when provider behavior changes. Do not assume every model family member supports the same levels.

- [AI SDK reasoning and precedence](https://ai-sdk.dev/docs/ai-sdk-core/reasoning)
- [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning)
- [Claude thinking controls](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost)
- [Gemini thinking](https://ai.google.dev/gemini-api/docs/thinking)
- [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [GLM deep thinking](https://docs.z.ai/guides/capabilities/thinking)
- [Qwen thinking and budgets](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)
- [Kimi parameter constraints](https://platform.kimi.ai/docs/api/models-overview)
- [MiMo V2.6 Pro API example](https://mimo.mi.com/models/en-US/mimo-v2.6-pro)

Verification uses fetch stubs to inspect actual installed-adapter request bodies without provider calls. Cover capability filtering, exact wire values, inheritance, persistence/reload, invalid settings, legacy compatibility, output budgeting, and background-policy isolation when changing this feature.
