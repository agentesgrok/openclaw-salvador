// Test pro handler skills/run-skill — mocka claude-query.query() async generator.

jest.mock('../../claude-query', () => ({
  query: jest.fn(),
}));

const { query } = require('../../claude-query');
const { handle, SKILLS_ALLOWED } = require('../../services/skills/run-skill');

// Helper: cria async iterable que yields mensagens canônicas do Claude SDK
function* mockMessages(opts = {}) {
  yield { type: 'system', subtype: 'init', model: opts.model || 'claude-opus-4-6' };
  yield { type: 'assistant', message: { content: [{ type: 'text', text: opts.text || 'oi' }] } };
  yield {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: opts.text || 'oi',
    duration_ms: 1234,
    num_turns: 1,
    total_cost_usd: 0.05,
  };
}

describe('skills run-skill handler', () => {
  beforeEach(() => jest.clearAllMocks());

  test('prompt direto (sem skill) retorna result', async () => {
    query.mockImplementation(async function* () { yield* mockMessages({ text: 'oi funcionando' }); });

    const r = await handle({ prompt: 'diga oi', maxTurns: 1 });
    expect(r.ok).toBe(true);
    expect(r.result).toBe('oi funcionando');
    expect(r.skillName).toBeNull();
    expect(r.costUsd).toBe(0.05);
    expect(r.turns).toBe(1);
    expect(r.model).toBe('claude-opus-4-6');
  });

  test('skillName válido prefixa prompt com /skill', async () => {
    query.mockImplementation(async function* () { yield* mockMessages(); });

    await handle({ skillName: 'simplify', prompt: 'limpa esse código' });
    const callArgs = query.mock.calls[0][0];
    expect(callArgs.prompt).toBe('/simplify limpa esse código');
  });

  test('skillName fora whitelist → ok:false sem chamar query', async () => {
    const r = await handle({ skillName: 'skill-inventada', prompt: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/whitelist/);
    expect(query).not.toHaveBeenCalled();
  });

  test('prompt vazio → ok:false sem chamar query', async () => {
    const r = await handle({ prompt: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/prompt obrigat/);
    expect(query).not.toHaveBeenCalled();
  });

  test('prompt undefined → ok:false', async () => {
    const r = await handle({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/prompt obrigat/);
  });

  test('result com is_error → propaga erro', async () => {
    query.mockImplementation(async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-opus-4-6' };
      yield { type: 'result', is_error: true, result: 'algo deu ruim', duration_ms: 100, num_turns: 0, total_cost_usd: 0 };
    });

    const r = await handle({ prompt: 'x', maxTurns: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/algo deu ruim/);
  });

  test('query lança exceção → ok:false', async () => {
    query.mockImplementation(async function* () { throw new Error('spawn ENOENT'); });

    const r = await handle({ prompt: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/spawn ENOENT/);
  });

  test('query encerra sem result event → ok:false', async () => {
    query.mockImplementation(async function* () {
      yield { type: 'system', subtype: 'init', model: 'm' };
      // sem result event
    });

    const r = await handle({ prompt: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sem evento result/);
  });

  test('SKILLS_ALLOWED inclui as skills chave', () => {
    ['pipeline-pdf-evolution', 'opensign-template', 'simplify', 'self-evolving'].forEach(s => {
      expect(SKILLS_ALLOWED.has(s)).toBe(true);
    });
  });
});
