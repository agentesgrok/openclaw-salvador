// Handler — POST /api/skills/run
//
// Dispara uma skill (.md global do Claude Code CLI ou skill local em backend/.claude/skills/)
// via Claude SDK spawnado por claude-query.js. Retorna o resultado final + custo + duração.
//
// Body:
//   {
//     "skillName": "pipeline-pdf-evolution",   // opcional — se vazio, roda prompt direto
//     "prompt": "...",                          // obrigatório
//     "maxTurns": 5,                            // default 5 (limite de iterações)
//     "allowedTools": ["Read","Bash"],          // default [] (nada — só texto)
//     "timeoutMs": 120000,                      // default 2min
//     "model": "claude-opus-4-6"                // opcional — default do SDK
//   }
//
// Response:
//   {
//     "ok": true,
//     "result": "<texto final do assistant>",
//     "skillName": "...",
//     "model": "claude-opus-4-6",
//     "turns": 1,
//     "durationMs": 3456,
//     "costUsd": 0.16,
//     "messagesCount": 4
//   }
//
// Whitelist: skills externas conhecidas. Pra adicionar nova, edita SKILLS_ALLOWED.
// Sem skillName, vira chat livre — útil pra debug/probe ("diga oi" sem ferramentas).

const { query } = require('../../claude-query');

const SKILLS_ALLOWED = new Set([
  'pipeline-pdf-evolution',
  'opensign-cliente',
  'opensign-documento',
  'opensign-template',
  'contrato-variaveis',
  'dossie-pos-assinatura-opensign',
  'openclaw-jarvis-whatsapp-send',
  'peca-lucro-ativo',
  'self-evolving',
  'simplify',
  'review',
  'security-review',
  // Skills do Claude Code que vêm built-in:
  'init',
  'claude-api',
]);

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c && c.type === 'text' && c.text)
      .map(c => c.text)
      .join('');
  }
  if (content.text) return content.text;
  return JSON.stringify(content).slice(0, 500);
}

async function handle(body = {}) {
  const startedAt = Date.now();
  const {
    skillName,
    prompt,
    maxTurns = 5,
    allowedTools = [],
    timeoutMs = 120000,
    model,
  } = body;

  // Validações
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return { ok: false, error: 'prompt obrigatório (string não vazia)' };
  }
  if (skillName && !SKILLS_ALLOWED.has(skillName)) {
    return {
      ok: false,
      error: `skill '${skillName}' não está na whitelist. Permitidas: ${Array.from(SKILLS_ALLOWED).join(', ')}`,
    };
  }

  // Monta prompt final: se tem skillName, prefixa com /skillName
  const finalPrompt = skillName ? `/${skillName} ${prompt}` : prompt;

  // AbortController com timeout
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  let assistantText = '';
  let resultEvent = null;
  const messages = [];
  let modelUsed = null;
  const stderrChunks = [];

  try {
    for await (const msg of query({
      prompt: finalPrompt,
      options: {
        maxTurns,
        permissionMode: 'bypassPermissions',
        allowedTools,
        model,
        abortController,
        stderr: (data) => { stderrChunks.push(data.toString().slice(0, 500)); },
      },
    })) {
      messages.push({ type: msg.type, subtype: msg.subtype });

      if (msg.type === 'system' && msg.subtype === 'init') {
        modelUsed = msg.model;
      }
      if (msg.type === 'assistant' && msg.message && msg.message.content) {
        assistantText += extractText(msg.message.content);
      }
      if (msg.type === 'result') {
        resultEvent = msg;
        break; // result é sempre o último
      }
    }
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      ok: false,
      error: `query() falhou: ${err.message}`,
      durationMs: Date.now() - startedAt,
      stderr: stderrChunks.slice(-3).join('\n').slice(0, 1000),
    };
  } finally {
    clearTimeout(timeoutId);
  }

  if (!resultEvent) {
    return {
      ok: false,
      error: 'query() encerrou sem evento result (provavelmente timeout ou abort)',
      durationMs: Date.now() - startedAt,
      messagesCount: messages.length,
      stderr: stderrChunks.slice(-3).join('\n').slice(0, 1000),
    };
  }

  if (resultEvent.is_error) {
    return {
      ok: false,
      error: resultEvent.result || resultEvent.error || 'erro desconhecido no Claude',
      durationMs: Date.now() - startedAt,
    };
  }

  const finalText = typeof resultEvent.result === 'string'
    ? resultEvent.result
    : (assistantText || JSON.stringify(resultEvent.result || {}).slice(0, 500));

  return {
    ok: true,
    result: finalText,
    skillName: skillName || null,
    model: modelUsed || resultEvent.model || null,
    turns: resultEvent.num_turns || 1,
    durationMs: Date.now() - startedAt,
    costUsd: resultEvent.total_cost_usd || 0,
    messagesCount: messages.length,
  };
}

module.exports = { handle, SKILLS_ALLOWED };
