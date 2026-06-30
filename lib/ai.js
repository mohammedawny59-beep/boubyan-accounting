/**
 * Unified Anthropic AI helper.
 * All routes in server.js must use callAI() instead of raw fetch().
 * Benefits: automatic retry, consistent error handling, single version pin.
 */
const Anthropic = require('@anthropic-ai/sdk');

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/**
 * @param {object} opts
 * @param {string} opts.model        - e.g. 'claude-haiku-4-5-20251001'
 * @param {Array}  opts.messages     - Anthropic messages array
 * @param {number} [opts.max_tokens] - default 512
 * @param {string} [opts.system]     - optional system prompt
 * @returns {Promise<string>}        - text content of first response block
 */
async function callAI({ model, messages, max_tokens = 512, system } = {}) {
  if (!model) throw new Error('callAI: model is required');
  const client = getClient();
  const params = { model, max_tokens, messages };
  if (system) params.system = system;

  const msg = await client.messages.create(params);
  return msg.content?.[0]?.text ?? '';
}

/**
 * Vision variant — passes a base64 image as the first message content block.
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.base64Image  - base64-encoded JPEG/PNG
 * @param {string} opts.mediaType    - e.g. 'image/jpeg'
 * @param {string} opts.prompt       - text prompt after the image
 * @param {number} [opts.max_tokens]
 * @returns {Promise<string>}
 */
async function callAIVision({ model, base64Image, mediaType = 'image/jpeg', prompt, max_tokens = 1000 } = {}) {
  return callAI({
    model,
    max_tokens,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
        { type: 'text', text: prompt },
      ],
    }],
  });
}

module.exports = { callAI, callAIVision };
