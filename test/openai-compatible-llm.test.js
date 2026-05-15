'use strict';

const { OpenAICompatibleLLM } = require('../lib/meridian-core/adapters/OpenAICompatibleLLM');

function mockFetch(response) {
  return async () => ({
    ok: response.ok !== false,
    status: response.status || 200,
    statusText: response.statusText || 'OK',
    async json() { return response.body; },
    async text() { return JSON.stringify(response.body || ''); },
  });
}

describe('OpenAICompatibleLLM', () => {
  test('constructor requires baseUrl and model', () => {
    expect(() => new OpenAICompatibleLLM({ model: 'x', fetch: mockFetch({ body: {} }) })).toThrow(/baseUrl/);
    expect(() => new OpenAICompatibleLLM({ baseUrl: 'http://x', fetch: mockFetch({ body: {} }) })).toThrow(/model/);
  });

  test('describe() returns provider info without api key', () => {
    const llm = new OpenAICompatibleLLM({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.2',
      apiKey: 'sk-secret',
      fetch: mockFetch({ body: {} }),
    });
    const desc = llm.describe();
    expect(desc.provider).toBe('ollama');
    expect(desc.baseUrl).toBe('http://localhost:11434/v1');
    expect(desc.defaultModel).toBe('llama3.2');
    expect('apiKey' in desc).toBe(false);
  });

  test('chat() posts to /chat/completions and returns parsed content', async () => {
    let captured;
    const llm = new OpenAICompatibleLLM({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.2',
      fetch: async (url, init) => {
        captured = { url, init };
        return {
          ok: true,
          async json() {
            return {
              model: 'llama3.2',
              choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            };
          },
          async text() { return ''; },
        };
      },
    });

    const result = await llm.chat({ messages: [{ role: 'user', content: 'ping' }] });
    expect(result.content).toBe('pong');
    expect(result.model).toBe('llama3.2');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });

    expect(captured.url).toMatch(/\/chat\/completions$/);
    expect(captured.init.method).toBe('POST');
    const body = JSON.parse(captured.init.body);
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }]);
    expect(body.model).toBe('llama3.2');
    expect('authorization' in captured.init.headers).toBe(false);
  });

  test('chat() sends Bearer auth when apiKey is set', async () => {
    let captured;
    const llm = new OpenAICompatibleLLM({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      fetch: async (url, init) => {
        captured = init;
        return { ok: true, async json() { return { choices: [{ message: { content: 'ok' } }] }; }, async text() { return ''; } };
      },
    });
    await llm.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(captured.headers.authorization).toBe('Bearer sk-test');
  });

  test('chat() rejects empty messages', async () => {
    const llm = new OpenAICompatibleLLM({
      baseUrl: 'http://x/v1', model: 'm', fetch: mockFetch({ body: {} }),
    });
    await expect(llm.chat({ messages: [] })).rejects.toThrow(/non-empty/);
  });

  test('chat() throws on non-OK response with body excerpt', async () => {
    const llm = new OpenAICompatibleLLM({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetch: async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        async json() { return {}; },
        async text() { return 'missing key'; },
      }),
    });
    await expect(llm.chat({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow(/401 Unauthorized.*missing key/);
  });

  test('chat() passes temperature, maxTokens, stop, and json response_format', async () => {
    let captured;
    const llm = new OpenAICompatibleLLM({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetch: async (url, init) => {
        captured = JSON.parse(init.body);
        return { ok: true, async json() { return { choices: [{ message: { content: '{}' } }] }; }, async text() { return ''; } };
      },
    });
    await llm.chat({
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.1,
      maxTokens: 100,
      stop: ['\n\n'],
      json: true,
    });
    expect(captured.temperature).toBe(0.1);
    expect(captured.max_tokens).toBe(100);
    expect(captured.stop).toEqual(['\n\n']);
    expect(captured.response_format).toEqual({ type: 'json_object' });
  });
});
