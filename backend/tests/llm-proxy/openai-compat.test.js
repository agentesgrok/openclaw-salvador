// Testa a conversão OpenAI messages[] → prompt/system do CLI e a resolução de modelo.
// claude-query é mockado: nada é spawnado e o setInterval do semáforo não segura o jest.
jest.mock('../../claude-query', () => ({ query: jest.fn(), isThrottled: () => false }));

const { buildPrompt, resolveModel, exposedModels } = require('../../services/llm-proxy/openai-compat');

describe('resolveModel', () => {
  const saved = {};
  beforeEach(() => {
    for (const k of ['LLM_PROXY_MODELS', 'LLM_PROXY_DEFAULT_MODEL']) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  test('aceita id com prefixo de provider', () => {
    expect(resolveModel('mythos/claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  test('id desconhecido ou vazio cai no default', () => {
    expect(resolveModel('gpt-4o')).toBe(exposedModels()[0]);
    expect(resolveModel('')).toBe(exposedModels()[0]);
  });

  test('LLM_PROXY_MODELS e LLM_PROXY_DEFAULT_MODEL são respeitados', () => {
    process.env.LLM_PROXY_MODELS = 'a-model, b-model';
    process.env.LLM_PROXY_DEFAULT_MODEL = 'b-model';
    expect(exposedModels()).toEqual(['a-model', 'b-model']);
    expect(resolveModel('a-model')).toBe('a-model');
    expect(resolveModel('zzz')).toBe('b-model');
  });
});

describe('buildPrompt', () => {
  test('system vai pro system prompt; histórico vira transcript; última do user é o pedido', () => {
    const { prompt, system } = buildPrompt([
      { role: 'system', content: 'Você é útil.' },
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'olá' },
      { role: 'user', content: 'qual a capital do Brasil?' },
    ]);
    expect(system).toMatch(/^Você é útil\./);
    expect(prompt).toContain('Histórico da conversa até agora');
    expect(prompt).toContain('Usuário: oi');
    expect(prompt).toContain('Assistente: olá');
    expect(prompt).toMatch(/Usuário: qual a capital do Brasil\?\n\nAssistente:$/);
  });

  test('sem tools: aviso diz que não há ferramentas', () => {
    const { system } = buildPrompt([{ role: 'user', content: 'x' }]);
    expect(system).toContain('não há ferramentas disponíveis');
  });

  test('com tools: aviso lista exatamente as liberadas', () => {
    const { system } = buildPrompt([{ role: 'user', content: 'x' }], ['mcp__guimoo__list_funis', 'Read']);
    expect(system).toContain('mcp__guimoo__list_funis, Read');
  });

  test('conteúdo multipart: texto é concatenado, imagem e áudio viram marcador', () => {
    const { prompt } = buildPrompt([{ role: 'user', content: [
      { type: 'text', text: 'veja: ' },
      { type: 'image_url', image_url: { url: 'data:...' } },
      { type: 'input_audio', input_audio: {} },
    ] }]);
    expect(prompt).toContain('veja: [imagem omitida][audio omitido]');
  });

  test('messages sem user: só o system vai pro system prompt e o prompt fica só com o marcador', () => {
    const { prompt, system } = buildPrompt([{ role: 'system', content: 'só system' }]);
    expect(system).toMatch(/^só system/);
    expect(prompt).toBe('Assistente:');
  });
});
