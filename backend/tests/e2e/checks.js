// tests/e2e/checks.js — as três camadas do e2e real.
//
//  0. preflight : sem token. Serviços, portas, auth, chaves iguais, CLI, MCP no disco, gateway, WhatsApp.
//  1. backend   : com token. POST /v1 direto (texto, stream, Guimoo read-only).
//  2. gateway   : com token. Turno completo pelo gateway (`openclaw agent`) em sessão descartável.
//
// Cada check chama ctx.step(id, layer, fn, opts). fn devolve { reason, extra? } em PASS,
// lança Error em FAIL (err.hint = camada quebrada), ou devolve { skip: 'motivo' }.

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const GUIMOO_PROMPT = 'SOMENTE LEITURA: não crie, altere nem apague nada. Use a ferramenta list_funis do Guimoo e responda APENAS no formato FUNIS=<quantidade>. Se a ferramenta não existir, responda exatamente SEM_FERRAMENTA.';
const PLAIN_PROMPT = 'Responda somente: ok';

function fail(msg, hint) { const e = new Error(msg); e.hint = hint; return e; }
const bareModel = id => (id || '').includes('/') ? id.split('/').pop() : (id || '');

// ─────────────────────────── Camada 0 ───────────────────────────

async function preflight(ctx) {
  const { env, baseUrl, step } = ctx;
  const port = Number(new URL(baseUrl).port || 80);

  await step('pre.units', 'preflight', async () => {
    const r = await L.run('systemctl', ['--user', 'is-active', 'mythos-backend.service', 'openclaw-gateway.service'], { timeoutMs: 5000 });
    if (r.code === -1) return { skip: 'systemctl indisponível' };
    const [be, gw] = r.stdout.trim().split('\n');
    if (be !== 'active') throw fail(`mythos-backend.service: ${be} — journalctl --user -u mythos-backend -n 30 (CHDIR? rode deploy/install-service.sh)`, 'backend down');
    if (gw !== 'active') throw fail(`openclaw-gateway.service: ${gw} — journalctl --user -u openclaw-gateway -n 30`, 'gateway down');
    return { reason: 'backend active, gateway active' };
  }, { gate: 'preflight' });

  await step('pre.ports', 'preflight', async () => {
    const be = await L.tcpConnect('127.0.0.1', port);
    const gw = await L.tcpConnect('127.0.0.1', 18789);
    if (!be) throw fail(`porta ${port} (backend) fechada`, 'backend down');
    if (!gw) throw fail('porta 18789 (gateway RPC) fechada', 'gateway down');
    return { reason: `${port} e 18789 abertas` };
  }, { gate: 'preflight' });

  await step('pre.models', 'preflight', async () => {
    const r = await L.fetchJson(`${baseUrl}/v1/models`, { timeoutMs: 5000 });
    if (r.status !== 200 || !Array.isArray(r.json?.data)) throw fail(`GET /v1/models → ${r.status}`, 'backend down');
    const ids = r.json.data.map(m => m.id);
    if (!ids.includes(ctx.primaryModel)) throw fail(`modelo primário do gateway (${ctx.primaryModel}) não está em LLM_PROXY_MODELS [${ids.join(', ')}]`, 'config mismatch');
    return { reason: `expõe ${ids.join(', ')}` };
  }, { gate: 'preflight' });

  await step('pre.health', 'preflight', async () => {
    const r = await L.fetchJson(`${baseUrl}/api/health?force=1`, { timeoutMs: 10000 });
    const c = r.json?.checks;
    if (!c || !c.process_throttle || !c.claude_code_sdk) throw fail(`/api/health sem o formato esperado (status ${r.status})`, 'backend down');
    if (c.claude_code_sdk.status === 'error') throw fail(`claude_code_sdk: ${c.claude_code_sdk.message || 'error'}`, 'CLI broken');
    ctx.active = c.process_throttle.activeProcesses;
    // throttled por memória do host = problema real; throttled só por slot ocupado (1/1) é tráfego → pre.slot trata (exit 2)
    const memPct = Number(c.process_throttle.memoryPercent), memMax = Number(c.process_throttle.throttleThreshold);
    if (c.process_throttle.throttled && memPct > memMax) throw fail(`backend throttled por memória: ${c.process_throttle.message}`, 'throttled');
    return { reason: `${r.json.status}; ${c.process_throttle.message}` };
  }, { gate: 'preflight' });

  await step('pre.slot', 'preflight', async () => {
    if (ctx.active == null) { ctx.gates.slot = false; return { skip: 'pre.health falhou' }; }
    if (ctx.active !== 0) {
      ctx.blocked = `slot do CLI ocupado (activeProcesses=${ctx.active}) — alguém está usando o agente; rode de novo em 1 min`;
      throw fail(ctx.blocked, 'throttled');
    }
    return { reason: 'activeProcesses=0' };
  }, { gate: 'slot' });

  await step('pre.cli', 'preflight', async () => {
    const cli = path.join(L.BACKEND_DIR, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (!fs.existsSync(cli)) throw fail('node_modules/@anthropic-ai/claude-code/cli.js ausente — npm install', 'CLI broken');
    const nodeBin = env.CLAUDE_NODE_BIN || 'node';
    const r = await L.run(nodeBin, [cli, '--version'], { timeoutMs: 15000 });
    const v = r.stdout.match(/\d+\.\d+\.\d+/);
    if (r.code !== 0 || !v) throw fail(`cli.js --version falhou com ${nodeBin} (exit ${r.code}): ${L.redact(r.stderr).slice(0, 160)}`, 'CLI broken');
    return { reason: `claude-code ${v[0]} via ${nodeBin}` };
  }, { gate: 'preflight' });

  await step('pre.mcp-config', 'preflight', async () => {
    const file = path.resolve(L.BACKEND_DIR, env.LLM_PROXY_MCP_CONFIG || '');
    if (!env.LLM_PROXY_MCP_CONFIG || !fs.existsSync(file)) throw fail('LLM_PROXY_MCP_CONFIG ausente ou arquivo não existe', 'MCP broken');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const g = cfg.mcpServers?.guimoo;
    if (!g) throw fail('mcp-servers.json sem server "guimoo"', 'MCP broken');
    // O CLI expande ${VAR} e ${VAR:-default} em command/args/env com o env do backend.
    const expand = s => String(s || '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k, d) => env[k] ?? process.env[k] ?? d ?? '');
    const cmd = expand(g.command), entry = expand(g.args?.[0]);
    const cmdPath = cmd.includes('/') ? cmd : (await L.run('sh', ['-c', `command -v ${cmd}`], { timeoutMs: 3000 })).stdout.trim();
    try { fs.accessSync(cmdPath, fs.constants.X_OK); } catch { throw fail(`command do MCP não executável: ${cmd}`, 'MCP broken'); }
    if (g.args?.[0] && !fs.existsSync(entry)) throw fail(`entrypoint do MCP não existe: ${entry}`, 'MCP broken');
    const keyRef = g.env?.GUIMOO_API_KEY || '';
    const key = keyRef.startsWith('${') ? env[keyRef.slice(2, -1)] : keyRef;
    if (!key) throw fail('GUIMOO_API_KEY vazio (mcp-servers.json / .env)', 'MCP broken');
    const allow = (env.LLM_PROXY_ALLOWED_TOOLS || '').split(',').map(s => s.trim());
    if (!allow.includes('mcp__guimoo__list_funis')) throw fail('LLM_PROXY_ALLOWED_TOOLS não libera mcp__guimoo__list_funis', 'MCP broken');
    if (!(parseInt(env.LLM_PROXY_MAX_TURNS || '1', 10) > 1)) throw fail('LLM_PROXY_MAX_TURNS <= 1 — tools não executam', 'MCP broken');
    return { reason: `guimoo ok, ${allow.length} tools liberadas, max_turns=${env.LLM_PROXY_MAX_TURNS}` };
  }, { gate: 'mcp' });

  await step('pre.auth-equal', 'preflight', async () => {
    // `openclaw config get` redige segredos → lê o JSON direto (só para comparar; nunca imprime).
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(path.join(L.os.homedir(), '.openclaw', 'openclaw.json'), 'utf8')); }
    catch (e) { return { skip: `não consegui ler ~/.openclaw/openclaw.json (${e.code || e.message})` }; }
    const prov = cfg.models?.providers?.mythos;
    const gwKey = prov?.apiKey, gwUrl = prov?.baseUrl, gwApi = prov?.api;
    L.addSecret(gwKey);
    if (!prov) throw fail('openclaw.json: provider mythos não encontrado', 'config mismatch');
    if (gwKey !== env.LLM_PROXY_API_KEY) throw fail('apiKey do provider mythos (openclaw.json) ≠ LLM_PROXY_API_KEY (backend/.env) → 401 em produção', 'auth mismatch');
    if ((gwUrl || '').replace(/\/$/, '') !== `${baseUrl}/v1`) throw fail(`baseUrl do gateway (${gwUrl}) ≠ ${baseUrl}/v1`, 'config mismatch');
    if (gwApi !== 'openai-completions') throw fail(`api do provider mythos = ${gwApi}`, 'config mismatch');
    if (!(ctx.primaryRaw || '').startsWith('mythos/')) throw fail(`modelo primário do gateway não é mythos/*: ${ctx.primaryRaw}`, 'config mismatch');
    return { reason: `chave igual, baseUrl ok, primário ${ctx.primaryRaw}` };
  }, { gate: 'preflight' });

  await step('pre.auth-401', 'preflight', async () => {
    const a = await L.fetchJson(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer invalid-e2e' }, body: { model: ctx.primaryModel, messages: [{ role: 'user', content: 'x' }] }, timeoutMs: 5000 });
    const b = await L.fetchJson(`${baseUrl}/api/tasks`, { timeoutMs: 5000 });
    if (a.status !== 401) throw fail(`/v1 com Bearer inválido → ${a.status} (esperado 401)`, 'auth broken');
    if (b.status !== 401) throw fail(`/api/tasks sem Bearer → ${b.status} (esperado 401)`, 'auth broken');
    return { reason: '/v1 e /api rejeitam token inválido' };
  });

  await step('pre.gw-health', 'preflight', async () => {
    const r = await L.openclaw(['gateway', 'call', 'health', '--json', '--timeout', '10000'], 20000);
    const j = L.parseJsonLoose(r.stdout);
    if (r.code !== 0 || !j) throw fail(`gateway call health falhou (exit ${r.code}): ${L.redact(r.stderr).slice(0, 160)}`, 'gateway down');
    if (j.ok !== true) throw fail('gateway health ok=false', 'gateway down');
    const errs = Array.isArray(j.plugins?.errors) ? j.plugins.errors : (Array.isArray(j.errors) ? j.errors : []);
    if (errs.length) throw fail(`gateway com ${errs.length} erro(s) de plugin`, 'gateway down');
    if (!j.channels?.whatsapp) throw fail('gateway sem canal whatsapp carregado', 'whatsapp channel off');
    return { reason: `ok, whatsapp ${j.channels.whatsapp.healthState || (j.channels.whatsapp.connected ? 'connected' : '?')}` };
  }, { gate: 'gateway' });

  await step('pre.gw-channels', 'preflight', async () => {
    const r = await L.openclaw(['channels', 'status', '--json'], 20000);
    const j = L.parseJsonLoose(r.stdout);
    const wa = j?.channels?.whatsapp;
    if (!wa) throw fail('channels status sem whatsapp', 'whatsapp disconnected');
    if (wa.connected !== true) throw fail('WhatsApp não está connected (não é culpa do mythos) — openclaw channels status', 'whatsapp disconnected');
    const issues = Array.isArray(j.statusIssues) ? j.statusIssues.length : 0;
    if (issues) throw fail(`channels status com ${issues} issue(s)`, 'whatsapp disconnected');
    return { reason: `connected, linked=${wa.linked}, issues=0` };
  });

  await step('pre.gw-log', 'preflight', async () => {
    const f = `/tmp/openclaw/openclaw-${new Date().toISOString().slice(0, 10)}.log`;
    try { fs.accessSync(f, fs.constants.R_OK); } catch { return { skip: `log do gateway indisponível (${f}); gw.log-clean será pulado` }; }
    ctx.gatewayLog = true;
    return { reason: path.basename(f) };
  });
}

// ─────────────────────────── Camada 1 ───────────────────────────

async function waitSlotFree(ctx, maxMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const r = await L.fetchJson(`${ctx.baseUrl}/api/health?force=1`, { timeoutMs: 8000 }).catch(() => null);
    const a = r?.json?.checks?.process_throttle?.activeProcesses;
    if (a === 0) return true;
    await L.sleep(3000);
  }
  return false;
}

function chatBody(model, prompt, stream) {
  return { model, messages: [{ role: 'user', content: prompt }], ...(stream ? { stream: true } : {}) };
}

function classifyChatFailure(r) {
  if (r.status === 401) return fail('401 — Bearer rejeitado (LLM_PROXY_API_KEY?)', 'auth mismatch');
  if (r.status === 502) return fail(`502 upstream_error: ${L.redact(r.json?.error?.message || '').slice(0, 200)} — claude login? CLAUDE_NODE_BIN?`, 'CLI broken');
  return fail(`HTTP ${r.status}: ${L.redact(r.text).slice(0, 160)}`, 'backend down');
}

async function backend(ctx) {
  const { baseUrl, step, bearer, primaryModel } = ctx;
  const headers = { Authorization: `Bearer ${bearer}` };
  const guard = async () => { if (!(await waitSlotFree(ctx))) return { skip: 'slot ocupado durante a execução (tráfego real)' }; return null; };

  await step('be.plain', 'backend', async () => {
    const s = await guard(); if (s) { ctx.blocked = s.skip; return s; }
    const r = await L.fetchJson(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: chatBody(primaryModel, PLAIN_PROMPT), timeoutMs: ctx.turnTimeoutMs });
    if (r.status !== 200) throw classifyChatFailure(r);
    const text = r.json?.choices?.[0]?.message?.content || '';
    if (!text.trim()) throw fail('resposta vazia', 'CLI broken');
    if (text.startsWith('Erro:')) throw fail(`resposta de erro: ${L.redact(text).slice(0, 160)}`, 'CLI broken (resposta parcial)');
    if (!/ok/i.test(text)) throw fail(`texto inesperado: ${L.redact(text).slice(0, 80)}`, 'CLI broken');
    const tok = r.json.usage?.total_tokens || 0;
    if (!(tok > 0)) throw fail('usage.total_tokens = 0', 'CLI broken');
    ctx.tokens += tok;
    return { reason: `"${text.trim().slice(0, 20)}", ${tok} tokens`, extra: { usage: r.json.usage } };
  }, { token: true, timeoutMs: ctx.turnTimeoutMs + 5000 });

  await step('be.stream', 'backend', async () => {
    const s = await guard(); if (s) { ctx.blocked = s.skip; return s; }
    const r = await L.fetchSse(`${baseUrl}/v1/chat/completions`, { headers, body: chatBody(primaryModel, PLAIN_PROMPT, true), timeoutMs: ctx.turnTimeoutMs });
    if (r.status !== 200) throw classifyChatFailure({ status: r.status, json: L.parseJsonLoose(r.raw || ''), text: r.raw || '' });
    if (!r.contentType.startsWith('text/event-stream')) throw fail(`content-type ${r.contentType} (esperado text/event-stream)`, 'stream broken');
    const missing = [];
    if (!r.chunks.some(c => typeof c.choices?.[0]?.delta?.content === 'string' && c.choices[0].delta.content)) missing.push('delta.content');
    if (!r.usage) missing.push('chunk de usage');
    if (!r.gotDone) missing.push('[DONE]');
    if (missing.length) throw fail(`SSE sem: ${missing.join(', ')} — OpenClaw usa stream`, 'stream broken');
    if (r.text.startsWith('Erro:')) throw fail(`resposta de erro: ${L.redact(r.text).slice(0, 160)}`, 'CLI broken (resposta parcial)');
    if (!/ok/i.test(r.text)) throw fail(`texto inesperado: ${L.redact(r.text).slice(0, 80)}`, 'CLI broken');
    ctx.tokens += r.usage.total_tokens || 0;
    return { reason: `${r.chunks.length} chunks, [DONE], ${r.usage.total_tokens} tokens`, extra: { usage: r.usage } };
  }, { token: true, timeoutMs: ctx.turnTimeoutMs + 5000 });

  await step('be.guimoo', 'backend', async () => {
    if (ctx.flags.skipGuimoo) return { skip: 'flag --skip-guimoo' };
    if (!ctx.gates.mcp) return { skip: 'pre.mcp-config falhou' };
    const s = await guard(); if (s) { ctx.blocked = s.skip; return s; }
    const r = await L.fetchJson(`${baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: chatBody(primaryModel, GUIMOO_PROMPT), timeoutMs: ctx.turnTimeoutMs * 1.5 });
    if (r.status !== 200) { const e = classifyChatFailure(r); if (r.status === 502) e.hint = 'MCP broken (tool falhou)'; throw e; }
    const text = r.json?.choices?.[0]?.message?.content || '';
    if (/SEM_FERRAMENTA/.test(text)) throw fail('modelo respondeu SEM_FERRAMENTA — CLI subiu sem o MCP guimoo (LLM_PROXY_MCP_CONFIG / --strict-mcp-config / restart do serviço)', 'MCP broken');
    if (text.startsWith('Erro:')) throw fail(`erro na tool: ${L.redact(text).slice(0, 200)} (GUIMOO_API_KEY? rede?)`, 'MCP broken (tool falhou)');
    const m = text.match(/FUNIS=(\d+)/);
    if (!m) throw fail(`sem "FUNIS=<n>" na resposta: ${L.redact(text).slice(0, 120)}`, 'MCP broken (sem chamada de tool)');
    const tok = r.json.usage?.total_tokens || 0;
    ctx.tokens += tok;
    return { reason: `FUNIS=${m[1]}, ${tok} tokens`, extra: { usage: r.json.usage, funis: Number(m[1]) } };
  }, { token: true, timeoutMs: ctx.turnTimeoutMs * 1.5 + 5000 });
}

// ─────────────────────────── Camada 2 ───────────────────────────

async function agentTurn(ctx, key, prompt, timeoutS) {
  const t0 = Date.now();
  const r = await L.openclaw(['agent', '--session-key', key, '-m', prompt, '--json', '--timeout', String(timeoutS)], timeoutS * 1000 + 20000);
  const t1 = Date.now();
  const j = L.parseJsonLoose(r.stdout);
  return { r, j, t0, t1 };
}

function assertAgentTurn(ctx, { r, j }, expectRe) {
  if (r.timedOut) throw fail(`openclaw agent excedeu o timeout`, 'gateway hung');
  if (r.code !== 0 || !j) {
    const err = L.redact(r.stderr || r.stdout).trim().slice(-200);
    if (/All models failed/.test(err)) throw fail(`gateway: All models failed — mythos recusou/caiu (journalctl --user -u mythos-backend -n 50)`, 'gateway→backend broken');
    throw fail(`openclaw agent exit ${r.code}: ${err}`, 'gateway→backend broken');
  }
  const status = L.pickFirst(j, ['status']);
  const text = L.pickFirst(j, ['result.payloads.0.text', 'payloads.0.text', 'text']) || '';
  const provider = L.pickFirst(j, ['result.meta.agentMeta.provider', 'meta.agentMeta.provider', 'provider']);
  const model = L.pickFirst(j, ['result.meta.agentMeta.model', 'meta.agentMeta.model', 'model']);
  const aborted = L.pickFirst(j, ['result.meta.aborted', 'meta.aborted']);
  if (provider === undefined) throw fail('campo provider não encontrado no JSON do openclaw agent (formato mudou?)', 'gateway→backend broken');
  if (provider !== 'mythos') throw fail(`provider=${provider} — caiu no FALLBACK: mythos falhou do ponto de vista do gateway (journalctl --user -u mythos-backend -n 50)`, 'fallback happened');
  if (status !== 'ok' || aborted === true) throw fail(`status=${status} aborted=${aborted}`, 'agent error');
  if (!String(text).trim()) throw fail('resposta vazia do agente', 'agent error');
  if (!expectRe.test(text)) throw fail(`texto inesperado: ${L.redact(text).slice(0, 120)}`, 'agent error');
  const total = L.pickFirst(j, ['result.meta.agentMeta.usage.total']);
  return { text: String(text), provider, model, total };
}

async function gateway(ctx) {
  const { step } = ctx;
  if (ctx.flags.skipGateway) { await step('gw.plain', 'gateway', async () => ({ skip: 'flag --skip-gateway' })); return; }
  if (!ctx.gates.gateway) { await step('gw.plain', 'gateway', async () => ({ skip: 'pre.gw-health falhou' })); return; }

  // Faxina: sessões e2e de execuções que morreram (> 60 min).
  try {
    const r = await L.openclaw(['sessions', 'list', '--json'], 20000);
    const items = L.firstArray(L.parseJsonLoose(r.stdout));
    for (const s of items) {
      if (/^agent:main:e2e-\d+$/.test(s.key || '') && (s.ageMs || 0) > 3600000) {
        await L.openclaw(['sessions', 'delete', s.key, '--yes', '--json'], 15000);
        ctx.log(`faxina: sessão antiga ${s.key} removida`);
      }
    }
  } catch { /* faxina é best-effort */ }

  const key = `agent:main:e2e-${Date.now()}`;
  const turnS = Math.ceil(ctx.turnTimeoutMs / 1000);
  let t0 = Date.now(), t1 = t0;

  try {
    await step('gw.plain', 'gateway', async () => {
      if (!(await waitSlotFree(ctx))) { ctx.blocked = 'slot ocupado (tráfego real)'; return { skip: ctx.blocked }; }
      ctx.sessionKey = key; // a partir daqui a sessão pode existir no gateway
      const turn = await agentTurn(ctx, key, PLAIN_PROMPT, turnS);
      t0 = Math.min(t0, turn.t0); t1 = turn.t1;
      const a = assertAgentTurn(ctx, turn, /ok/i);
      if (!String(a.model || '').startsWith('claude-')) throw fail(`model=${a.model}`, 'config mismatch');
      return { reason: `provider=${a.provider} model=${a.model}, ${L.fmtMs(turn.t1 - turn.t0)}`, extra: { usageTotal: a.total } };
    }, { token: true, timeoutMs: turnS * 1000 + 25000 });

    await step('gw.guimoo', 'gateway', async () => {
      if (ctx.flags.skipGuimoo) return { skip: 'flag --skip-guimoo' };
      if (!ctx.gates.mcp) return { skip: 'pre.mcp-config falhou' };
      if (ctx.results.find(x => x.id === 'gw.plain')?.status !== 'PASS') return { skip: 'gw.plain não passou' };
      if (!(await waitSlotFree(ctx))) { ctx.blocked = 'slot ocupado (tráfego real)'; return { skip: ctx.blocked }; }
      const turn = await agentTurn(ctx, key, GUIMOO_PROMPT, Math.ceil(turnS * 1.5));
      t1 = turn.t1;
      const a = assertAgentTurn(ctx, turn, /FUNIS=\d+|SEM_FERRAMENTA/);
      if (/SEM_FERRAMENTA/.test(a.text)) throw fail('agente respondeu SEM_FERRAMENTA pelo gateway — MCP guimoo não chegou ao CLI', 'MCP broken');
      const m = a.text.match(/FUNIS=(\d+)/);
      return { reason: `FUNIS=${m[1]} via gateway, ${L.fmtMs(turn.t1 - turn.t0)}`, extra: { funis: Number(m[1]) } };
    }, { token: true, timeoutMs: turnS * 1500 + 25000 });

    await step('gw.log-clean', 'gateway', async () => {
      if (!ctx.gatewayLog) return { skip: 'log do gateway indisponível' };
      if (!ctx.results.some(x => x.layer === 'gateway' && x.status === 'PASS')) return { skip: 'nenhum turno executado' };
      const { counts } = L.countGatewayMarkers(t0 - 2000, t1 + 2000);
      const bad = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`);
      if (bad.length) throw fail(`marcadores de falha no log do gateway na janela do teste: ${bad.join(', ')}`, 'fallback happened');
      return { reason: 'sem fallback/erro de provider na janela', extra: { markers: counts } };
    });
  } finally {
    if (!ctx.sessionKey) {
      /* nenhum turno rodou: não há sessão para apagar */
    } else if (ctx.flags.keepSession) {
      ctx.log(`--keep-session: sessão ${key} mantida (apague com: openclaw sessions delete "${key}" --yes)`);
    } else {
      const d = await L.openclaw(['sessions', 'delete', key, '--yes', '--json'], 15000);
      const j = L.parseJsonLoose(d.stdout);
      if (d.code !== 0 || j?.ok === false) ctx.log(`AVISO: não consegui apagar a sessão ${key} — openclaw sessions delete "${key}" --yes`);
      else ctx.log(`sessão ${key} removida`);
    }
    ctx.sessionKey = null;
  }
}

module.exports = { preflight, backend, gateway, GUIMOO_PROMPT, PLAIN_PROMPT };
