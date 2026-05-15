'use strict';

/**
 * ILLMProvider — port for LLM chat completion.
 *
 * Recall Meridian features (Trace Optimizer reflection, consolidation
 * services, etc.) call LLMs through this port rather than directly
 * importing OpenAI/Anthropic/Ollama SDKs. Adapters implement against
 * specific endpoints; "OpenAI-compatible" covers Ollama, LM Studio,
 * vLLM, llama.cpp, and the OpenAI/Together/Groq/Fireworks family.
 *
 * Cockburn 2005 hexagonal: core defines what it needs; adapters deliver it.
 *
 * @abstract
 */
class ILLMProvider {
  /**
   * @typedef {{ role: 'system'|'user'|'assistant', content: string }} ChatMessage
   *
   * @param {object} req
   * @param {ChatMessage[]} req.messages
   * @param {string} [req.model]              Override the adapter's default model.
   * @param {number} [req.temperature]        0..2; default depends on adapter.
   * @param {number} [req.maxTokens]          Output cap; default depends on adapter.
   * @param {string[]} [req.stop]             Stop sequences.
   * @param {boolean} [req.json]              Ask the model to return JSON-only.
   * @returns {Promise<{ content: string, model: string, finishReason: string, usage?: object, raw?: object }>}
   */
  async chat(req) { throw new Error('not implemented: ILLMProvider#chat'); }

  /**
   * Identity + endpoint info for diagnostics (config print, arch-audit).
   * Adapters should NOT include the API key.
   *
   * @returns {{ provider: string, baseUrl: string, defaultModel: string }}
   */
  describe() { throw new Error('not implemented: ILLMProvider#describe'); }
}

module.exports = { ILLMProvider };
