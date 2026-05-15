'use strict';

// OpenAICompatibleLLM — single adapter that talks to any endpoint speaking
// OpenAI's /v1/chat/completions shape. Covers Ollama (with --serve), LM Studio,
// vLLM, llama.cpp, openai.com, Together, Groq, Fireworks, and most local hosts.
//
// Hex placement: lib/meridian-core/adapters/. Implements ILLMProvider from
// lib/meridian-core/ports/. Features import ILLMProvider, never this class
// directly — Trace Optimizer reflection, consolidation, harness recommendation
// all bind to the port.
//
// Local-first defaults: no API key required (Ollama / LM Studio); apiKey only
// sent when provided. Timeout defaults to 60s for slow local generation; the
// caller can override per-request.

const { ILLMProvider } = require('../ports/ILLMProvider');

const DEFAULT_TIMEOUT_MS = 60_000;

class OpenAICompatibleLLM extends ILLMProvider {
  /**
   * @param {object} opts
   * @param {string} opts.provider   Display name: "ollama" | "lmstudio" | "openai" | "vllm" | etc.
   * @param {string} opts.baseUrl    Endpoint ending in /v1 (no trailing slash, no /chat/completions).
   * @param {string} opts.model      Default model id when chat() doesn't override.
   * @param {string} [opts.apiKey]   Optional. Sent as Bearer auth. Empty/undefined = no auth header.
   * @param {number} [opts.timeoutMs]  Request timeout, default 60_000.
   * @param {typeof fetch} [opts.fetch]  Inject fetch for tests; defaults to global.
   */
  constructor(opts = {}) {
    super();
    if (!opts.baseUrl) throw new Error('OpenAICompatibleLLM: baseUrl is required');
    if (!opts.model) throw new Error('OpenAICompatibleLLM: model is required');
    this.provider = opts.provider || 'openai-compatible';
    this.baseUrl = String(opts.baseUrl).replace(/\/+$/, '');
    this.model = opts.model;
    this.apiKey = opts.apiKey || '';
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    this._fetch = opts.fetch || globalThis.fetch;
    if (!this._fetch) {
      throw new Error('OpenAICompatibleLLM: no fetch implementation available (Node >= 18 or pass opts.fetch)');
    }
  }

  describe() {
    return {
      provider: this.provider,
      baseUrl: this.baseUrl,
      defaultModel: this.model,
    };
  }

  async chat(req = {}) {
    if (!Array.isArray(req.messages) || req.messages.length === 0) {
      throw new Error('OpenAICompatibleLLM.chat: req.messages must be a non-empty array');
    }

    const body = {
      model: req.model || this.model,
      messages: req.messages,
    };
    if (Number.isFinite(req.temperature)) body.temperature = req.temperature;
    if (Number.isFinite(req.maxTokens)) body.max_tokens = req.maxTokens;
    if (Array.isArray(req.stop) && req.stop.length > 0) body.stop = req.stop;
    if (req.json) body.response_format = { type: 'json_object' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this._fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        throw new Error(`OpenAICompatibleLLM.chat: request timed out after ${this.timeoutMs}ms at ${this.baseUrl}`);
      }
      throw new Error(`OpenAICompatibleLLM.chat: network error at ${this.baseUrl} — ${err.message || err}`);
    }
    clearTimeout(timer);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OpenAICompatibleLLM.chat: ${response.status} ${response.statusText} from ${this.baseUrl} — ${text.slice(0, 500)}`);
    }

    const data = await response.json();
    const choice = (data.choices && data.choices[0]) || {};
    const content = (choice.message && choice.message.content) || '';
    return {
      content,
      model: data.model || body.model,
      finishReason: choice.finish_reason || 'unknown',
      usage: data.usage,
      raw: data,
    };
  }
}

module.exports = { OpenAICompatibleLLM };
