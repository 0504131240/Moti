// Shared Claude call for the server functions: returns the parsed JSON answer
// for a prompt and a JSON schema. ANTHROPIC_MODEL overrides the model.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
// Server-side refusal fallbacks are available on these models
const HAS_FALLBACKS = /^claude-(opus-5|fable-5|sonnet-5-5)/.test(MODEL);

class Refused extends Error {}

async function askClaude(prompt, schema, maxTokens = 8000) {
  const client = new Anthropic();
  const params = {
    model: MODEL,
    max_tokens: maxTokens,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: prompt }],
  };
  const msg = HAS_FALLBACKS
    ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await client.messages.create(params);
  if (msg.stop_reason === 'refusal') throw new Refused('refused');
  const text = msg.content.find(b => b.type === 'text')?.text || '';
  return JSON.parse(text);
}

module.exports = { askClaude, Refused, Anthropic, MODEL };
