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

/**
 * Agentic loop — Claude calls tools until it finishes.
 * @param {object} opts
 * @param {string}   opts.model
 * @param {Array}    opts.messages
 * @param {Array}    opts.tools     - [{ name, description, input_schema, _handler }]
 * @param {string}   [opts.system]
 * @param {number}   [opts.max_tokens]
 * @param {number}   [opts.maxSteps]  - safety cap on tool-call rounds (default 8)
 * @returns {Promise<string>}  final text after all tool calls
 */
async function callAITools({ model, messages, tools, system, max_tokens = 2000, maxSteps = 8 } = {}) {
  if (!model) throw new Error('callAITools: model is required');
  const client = getClient();
  const history = [...messages];

  // Strip _handler before sending to API (it's our internal callback)
  const apiTools = tools.map(({ _handler, ...rest }) => rest);

  for (let step = 0; step < maxSteps; step++) {
    const params = { model, max_tokens, messages: history, tools: apiTools };
    if (system) params.system = system;

    const response = await client.messages.create(params);
    history.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock?.text ?? '';
    }

    // Execute each tool call Claude requested
    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const tool = tools.find(t => t.name === block.name);
      let result = 'Tool not found';
      if (tool?._handler) {
        try { result = await tool._handler(block.input); }
        catch (e) { result = `Error executing ${block.name}: ${e.message}`; }
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
      });
    }
    history.push({ role: 'user', content: toolResults });
  }
  return '';
}

module.exports = { callAI, callAIVision, callAITools };
