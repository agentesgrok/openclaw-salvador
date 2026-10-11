// Falha de spawn (binário inexistente) tem que virar um result de erro,
// não um evento 'error' não tratado que derruba o processo. Sem token, sem CLI.
const path = require('path');

describe('claude-query: spawn failure', () => {
  const saved = process.env.CLAUDE_NODE_BIN;
  beforeAll(() => { process.env.CLAUDE_NODE_BIN = path.join(__dirname, 'nao-existe-binario'); });
  afterAll(() => { if (saved === undefined) delete process.env.CLAUDE_NODE_BIN; else process.env.CLAUDE_NODE_BIN = saved; });

  test('binário inexistente → yield de result is_error em vez de crash', async () => {
    jest.isolateModules(() => { /* garante leitura do env novo */ });
    const { query } = require('../claude-query');
    const msgs = [];
    for await (const m of query({ prompt: 'oi', options: { maxTurns: 1 } })) msgs.push(m);
    const result = msgs.find(m => m.type === 'result');
    expect(result).toBeDefined();
    expect(result.is_error).toBe(true);
    expect(result.error).toMatch(/spawn failed/);
  });
});
