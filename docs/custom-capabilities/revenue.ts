import type { CustomToolModule } from '../../src/shared/customCapabilities';

/** Copy this file into the bot's workspace; change the API URL to your provider. */
export default {
  name: 'get_revenue',
  description: 'Fetch revenue for a month in YYYY-MM format.',
  inputSchema: {
    type: 'object',
    properties: { month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } },
    required: ['month'],
    additionalProperties: false,
  },
  requiredEnv: ['REVENUE_API_KEY'],
  async execute(input, context) {
    const { month } = input as { month: string };
    const response = await fetch(
      `https://api.example.com/revenue?month=${encodeURIComponent(month)}`,
      {
        headers: { Authorization: `Bearer ${context.env.REVENUE_API_KEY}` },
        signal: context.signal,
      },
    );
    if (!response.ok) throw new Error(`Revenue request failed: ${response.status}`);
    return response.json();
  },
} satisfies CustomToolModule;
