// services/llm-proxy/openai-compat.js
//
// Endpoint OpenAI-compatible (chat completions) em cima do claude-query.js.
// Permite que clientes que falam "OpenAI API" (ex: OpenClaw com api: "openai-completions")
// usem este backend como provider de modelo. O motor real é o Claude Code CLI
// (@anthropic-ai/claude-code) spawnado pelo claude-query.js — reaproveita o
// semáforo de processos + throttle de memória.
//
// Rotas (montadas em /v1 pelo server.js):
//   GET  /v1/models              — lista modelos expostos (sem auth; usado como health)
//   POST /v1/chat/completions    — chat completion (stream SSE ou JSON), Bearer auth
//
// Env:
//   LLM_PROXY_API_KEY          — Bearer esperado (fallback: WEBHOOK_CRM_SECRET)
//   LLM_PROXY_MODELS           — ids expostos, separados por vírgula
//                                (default: claude-sonnet-5,claude-opus-4-8,claude-opus-4-7)
//   LLM_PROXY_DEFAULT_MODEL    — usado quando o cliente pede um id desconhecido/vazio
//   LLM_PROXY_MAX_TURNS        — --max-turns do CLI (default 1 = só texto, sem loop de tools)
//   LLM_PROXY_ALLOWED_TOOLS    — tools liberadas, separadas por vírgula: built-ins ("Read") e/ou de MCP
//                                ("mcp__guimoo__list_funis"); default nenhuma. É ALLOWLIST de verdade: tudo
//                                que não está aqui é negado (o proxy não usa bypassPermissions).
//   LLM_PROXY_MCP_CONFIG       — JSON de MCP servers pro CLI (--mcp-config + --strict-mcp-config). Aceita
//                                ${VAR} no env dos servers; caminho relativo resolve a partir do cwd do backend.
//   LLM_PROXY_PERMISSION_MODE  — --permission-mode do CLI (default: não passa = "default" → nega o que não
//                                está na allowlist). NÃO usar bypassPermissions aqui: quem fala com este
//                                endpoint é gente no WhatsApp, e bypass libera Bash/Write e todas as tools do MCP.
//   LLM_PROXY_TOOLS_GUIDANCE   — texto livre anexado ao aviso de ferramentas (ex: confirmar antes de excluir).
//                                É orientação ao modelo, NÃO trava — a trava é a allowlist.
//   LLM_PROXY_TIMEOUT_MS       — timeout por request (default 300000)
//
// Limitações conhecidas:
//   - `tools`/`functions` do request OpenAI são IGNORADAS: o Claude CLI em --print não
//     devolve tool_calls no formato OpenAI. A resposta é sempre texto. Ferramenta pro agente = MCP
//     plugado AQUI (LLM_PROXY_MCP_CONFIG), executado dentro do CLI; `openclaw mcp add` não tem efeito.
//   - Sem `logprobs`, `n>1`, `response_format` json_schema.

const express = require('express');
const crypto = require('crypto');
const { query, isThrottled } = require('../../claude-query');

const path = require('path');

const router = express.Router();
router.use(express.json({ limit: '20mb' }));

const DEFAULT_MODELS = ['claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7'];

function exposedModels() {
  const raw = process.env.LLM_PROXY_MODELS;
  const list = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_MODELS;
  return list.length ? list : DEFAULT_MODELS;
}

function resolveModel(requested) {
  const models = exposedModels();
  const fallback = process.env.LLM_PROXY_DEFAULT_MODEL || models[0];
  if (!requested || typeof requested !== 'string') return fallback;
  // aceita "mythos/claude-sonnet-5" ou "claude-sonnet-5"
  const bare = requested.includes('/') ? requested.split('/').pop() : requested;
  return models.includes(bare) ? bare : fallback;
}

function auth(req, res, next) {
  const expected = process.env.LLM_PROXY_API_KEY || process.env.WEBHOOK_CRM_SECRET;
  if (!expected) {
    return res.status(500).json({ error: { message: 'LLM_PROXY_API_KEY nao configurado', type: 'server_error' } });
  }
  const header = req.headers.authorization || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(presented), b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    return res.status(401).json({ error: { message: 'unauthorized', type: 'invalid_request_error' } });
  }
  next();
}

// ── Conversão messages[] (OpenAI) → prompt + system prompt do CLI ──

function partText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => {
      if (!p) return '';
      if (typeof p === 'string') return p;
      if (p.type === 'text' && typeof p.text === 'string') return p.text;
      if (p.type === 'image_url') return '[imagem omitida]';
      if (p.type === 'input_audio') return '[audio omitido]';
      return '';
    }).join('');
  }
  if (typeof content.text === 'string') return content.text;
  return '';
}

function buildPrompt(messages, toolNames = []) {
  const systemParts = [];
  const turns = [];
  for (const m of messages) {
    if (!m || !m.role) continue;
    if (m.role === 'system' || m.role === 'developer') {
      const t = partText(m.content);
      if (t) systemParts.push(t);
      continue;
    }
    if (m.role === 'tool') {
      // resultado de tool do lado do cliente — vira contexto textual
      const t = partText(m.content);
      turns.push({ role: 'tool', text: t });
      continue;
    }
    let text = partText(m.content);
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map(tc => `[chamou ${tc.function?.name || 'tool'}(${tc.function?.arguments || ''})]`).join(' ');
      text = [text, calls].filter(Boolean).join('\n');
    }
    turns.push({ role: m.role, text });
  }

  // Última mensagem do usuário é o "prompt"; o resto vira transcript de contexto.
  let lastUserIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user') { lastUserIdx = i; break; }
  }
  const history = lastUserIdx >= 0 ? turns.slice(0, lastUserIdx) : turns;
  const current = lastUserIdx >= 0 ? turns[lastUserIdx].text : '';
  const trailing = lastUserIdx >= 0 ? turns.slice(lastUserIdx + 1) : [];

  const label = r => (r === 'user' ? 'Usuário' : r === 'assistant' ? 'Assistente' : 'Resultado de ferramenta');
  let prompt = '';
  if (history.length) {
    prompt += 'Histórico da conversa até agora (para contexto):\n\n';
    prompt += history.map(t => `${label(t.role)}: ${t.text}`).join('\n\n');
    prompt += '\n\n---\n\n';
  }
  prompt += current ? `Usuário: ${current}` : '';
  if (trailing.length) {
    prompt += '\n\n' + trailing.map(t => `${label(t.role)}: ${t.text}`).join('\n\n');
  }
  prompt += '\n\nAssistente:';

  const toolsHint = toolNames.length
    ? `Você está respondendo por uma API de chat. As ÚNICAS ferramentas que funcionam nesta chamada são: ${toolNames.join(', ')}. Qualquer outra ferramenta citada acima (exec, read, etc.) NÃO está disponível — não tente chamar. Quando a pergunta depender de dados reais, consulte a ferramenta antes de responder e nunca invente dados; se a ferramenta falhar, diga o erro. A resposta final é sempre texto.${process.env.LLM_PROXY_TOOLS_GUIDANCE ? ' ' + process.env.LLM_PROXY_TOOLS_GUIDANCE.trim() : ''}`
    : 'Você está respondendo por uma API de chat: não há ferramentas disponíveis nesta chamada. Responda diretamente em texto, sem tentar chamar ferramentas.';
  const system = [...systemParts, toolsHint].join('\n\n');
  return { prompt: prompt.trim() || '(mensagem vazia)', system };
}

// ── Helpers de resposta ──

function newId() { return 'chatcmpl-' + crypto.randomBytes(12).toString('hex'); }

function extractResultText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return result.filter(c => c && c.type === 'text').map(c => c.text).join('');
  if (result.text) return result.text;
  if (result.content) return extractResultText(result.content);
  return '';
}

function usageFrom(msg) {
  const u = msg && msg.usage ? msg.usage : {};
  const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const completion = u.output_tokens || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

// ── Rotas ──

router.get('/models', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  res.json({
    object: 'list',
    data: exposedModels().map(id => ({ id, object: 'model', created: now, owned_by: 'openclaw-mythos' })),
  });
});

router.post('/chat/completions', auth, async (req, res) => {
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length) {
    return res.status(400).json({ error: { message: 'messages[] obrigatório', type: 'invalid_request_error' } });
  }

  const model = resolveModel(body.model);
  const stream = body.stream === true;
  const id = newId();
  const created = Math.floor(Date.now() / 1000);
  const maxTurns = parseInt(process.env.LLM_PROXY_MAX_TURNS || '1', 10) || 1;
  const allowedTools = (process.env.LLM_PROXY_ALLOWED_TOOLS || '').split(',').map(s => s.trim()).filter(Boolean);
  const mcpConfig = (process.env.LLM_PROXY_MCP_CONFIG || '').trim();
  const { prompt, system } = buildPrompt(messages, allowedTools);
  const timeoutMs = parseInt(process.env.LLM_PROXY_TIMEOUT_MS || '300000', 10) || 300000;

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  req.on('close', () => { if (!res.writableEnded) abortController.abort(); });

  const options = {
    model,
    maxTurns,
    includePartialMessages: stream,
    appendSystemPrompt: system,
    abortController,
    cwd: process.cwd(),
    stderr: (d) => { if (process.env.NODE_ENV === 'development') console.log('[llm-proxy stderr]', d); },
  };
  // Só existem os built-ins listados na allowlist (nenhum, no caso comum de só-MCP)
  options.tools = allowedTools.filter(t => !t.startsWith('mcp__')).join(',');
  if (allowedTools.length) options.allowedTools = allowedTools;
  if (mcpConfig) {
    options.mcpConfig = path.resolve(process.cwd(), mcpConfig);
    options.strictMcpConfig = true;
  }
  if (process.env.LLM_PROXY_PERMISSION_MODE) options.permissionMode = process.env.LLM_PROXY_PERMISSION_MODE;

  if (isThrottled()) console.log('[llm-proxy] throttled — request enfileirado');

  let sentAny = false;
  let streamed = '';
  let finalText = '';
  let lastAssistantText = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let errorMsg = null;

  const writeChunk = (delta, finish) => {
    const chunk = {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: finish || null }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders && res.flushHeaders();
    writeChunk({ role: 'assistant', content: '' });
  }

  try {
    for await (const msg of query({ prompt, options })) {
      if (msg.type === 'stream_event' && msg.event) {
        const ev = msg.event;
        // Turno novo depois de tool: separa do texto já emitido ("Vou consultar…" + resposta)
        if (ev.type === 'message_start' && streamed && !streamed.endsWith('\n')) {
          streamed += '\n\n';
          if (stream) writeChunk({ content: '\n\n' });
        }
        if (ev.type === 'content_block_delta' && ev.delta && typeof ev.delta.text === 'string') {
          streamed += ev.delta.text;
          if (stream) { writeChunk({ content: ev.delta.text }); sentAny = true; }
        }
      } else if (msg.type === 'assistant' && msg.message) {
        const t = extractResultText(msg.message.content || msg.message);
        if (t) lastAssistantText = t;
      } else if (msg.type === 'result') {
        usage = usageFrom(msg);
        if (msg.is_error) {
          errorMsg = extractResultText(msg.result) || msg.error || 'Claude CLI error';
        } else {
          finalText = extractResultText(msg.result);
        }
      }
    }
  } catch (err) {
    errorMsg = err && err.message ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  if (abortController.signal.aborted && !errorMsg) errorMsg = 'request aborted (timeout ou cliente desconectou)';

  const text = finalText || lastAssistantText || streamed || '';

  if (stream) {
    if (res.writableEnded) return;
    if (errorMsg && !sentAny) {
      writeChunk({ content: `Erro: ${errorMsg}` });
    } else if (!sentAny && text) {
      // sem deltas parciais (ex: CLI sem partial messages) → manda tudo de uma vez
      writeChunk({ content: text });
    } else if (sentAny && finalText && finalText !== streamed && !streamed.trim()) {
      writeChunk({ content: finalText });
    }
    writeChunk({}, errorMsg ? 'stop' : 'stop');
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  if (errorMsg && !text) {
    return res.status(502).json({ error: { message: errorMsg, type: 'upstream_error' } });
  }
  return res.json({
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage,
  });
});

module.exports = { router, buildPrompt, resolveModel, exposedModels };
