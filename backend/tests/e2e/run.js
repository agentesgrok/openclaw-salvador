#!/usr/bin/env node
// tests/e2e/run.js — e2e REAL contra a produção: "mudei o mythos, o agente do WhatsApp continua funcionando?"
//
// Cadeia provada: gateway OpenClaw → POST /v1 (mythos :3456) → claude-query.js → Claude Code CLI → MCP guimoo.
// Gasta tokens de verdade (camadas backend e gateway). Nada é enviado ao WhatsApp.
//
//   npm run test:e2e                       # tudo (~2-6 min)
//   npm run test:e2e -- --only=preflight   # sem token (~10 s)
//   npm run test:e2e -- --skip-gateway     # só backend direto
//   npm run test:e2e -- --json             # relatório JSON no stdout (tabela vai pro stderr)
//
// Flags: --only=preflight,backend,gateway  --skip-gateway  --skip-guimoo  --bearer <token> (simular auth errada)
//        --base-url <url>  --timeout-turn <s> (default 180)  --budget-ms <n> (default 900000)  --keep-session  --verbose
//
// Exit: 0 = tudo PASS/SKIP por flag · 1 = algum FAIL · 2 = inconclusivo (slot do CLI ocupado, lock, orçamento).

const L = require('./lib');
const checks = require('./checks');

function parseArgs(argv) {
  const f = { only: null, skipGateway: false, skipGuimoo: false, bearer: null, baseUrl: null, turnS: 180, budgetMs: 900000, keepSession: false, json: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes('=') ? a.split('=').slice(1).join('=') : argv[++i]);
    if (a.startsWith('--only')) f.only = val().split(',').map(s => s.trim());
    else if (a === '--skip-gateway') f.skipGateway = true;
    else if (a === '--skip-guimoo') f.skipGuimoo = true;
    else if (a.startsWith('--bearer')) f.bearer = val();
    else if (a.startsWith('--base-url')) f.baseUrl = val();
    else if (a.startsWith('--timeout-turn')) f.turnS = parseInt(val(), 10) || 180;
    else if (a.startsWith('--budget-ms')) f.budgetMs = parseInt(val(), 10) || 900000;
    else if (a === '--keep-session') f.keepSession = true;
    else if (a === '--json') f.json = true;
    else if (a === '--verbose') f.verbose = true;
    else { console.error(`flag desconhecida: ${a}`); process.exit(2); }
  }
  return f;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const env = L.loadBackendEnv();
  const out = flags.json ? console.error : console.log;
  const log = msg => out(L.redact(msg));

  const ctx = {
    flags, env, log,
    baseUrl: (flags.baseUrl || `http://127.0.0.1:${env.PORT || 3456}`).replace(/\/$/, ''),
    bearer: flags.bearer || env.LLM_PROXY_API_KEY || env.API_SECRET || env.WEBHOOK_CRM_SECRET || '',
    turnTimeoutMs: flags.turnS * 1000,
    startedAt: Date.now(),
    results: [], tokens: 0, active: null, blocked: null, gatewayLog: false, sessionKey: null,
    gates: { preflight: true, slot: true, mcp: true, gateway: true },
  };
  L.addSecret(flags.bearer);

  // Modelo primário do gateway (ex.: mythos/claude-sonnet-5) — o que o WhatsApp realmente usa.
  ctx.primaryRaw = (await L.openclawConfigGet('agents.defaults.model.primary')) || '';
  ctx.primaryModel = ctx.primaryRaw.includes('/') ? ctx.primaryRaw.split('/').pop() : (ctx.primaryRaw || 'claude-sonnet-5');

  const wants = layer => !flags.only || flags.only.includes(layer);

  ctx.step = async (id, layer, fn, { gate = null, token = false, timeoutMs = 30000 } = {}) => {
    const t0 = Date.now();
    const rec = { id, layer, status: 'SKIP', ms: 0, reason: '', hint: null, extra: undefined };
    const finish = () => { rec.ms = Date.now() - t0; ctx.results.push(rec); if (!flags.json || flags.verbose) log(`${layer.padEnd(9)} ${id.padEnd(16)} ${rec.status.padEnd(5)} ${L.fmtMs(rec.ms).padStart(7)}  ${rec.reason}${rec.hint ? `  [${rec.hint}]` : ''}`); };
    try {
      if (!wants(layer)) { rec.reason = 'flag --only'; return finish(); }
      if (token && !ctx.gates.preflight) { rec.reason = 'preflight falhou'; return finish(); }
      if (token && !ctx.gates.slot) { rec.reason = ctx.blocked || 'slot ocupado'; return finish(); }
      if (token && Date.now() - ctx.startedAt + timeoutMs > flags.budgetMs) { rec.reason = 'orçamento de tempo esgotado'; ctx.blocked = ctx.blocked || rec.reason; return finish(); }
      const r = await Promise.race([fn(), L.sleep(timeoutMs).then(() => { throw Object.assign(new Error(`timeout ${L.fmtMs(timeoutMs)}`), { hint: 'hung' }); })]);
      if (r && r.skip) { rec.reason = r.skip; return finish(); }
      rec.status = 'PASS'; rec.reason = r?.reason || ''; rec.extra = r?.extra;
    } catch (err) {
      rec.status = 'FAIL'; rec.reason = L.redact(err.message); rec.hint = err.hint || null;
      if (gate) ctx.gates[gate] = false;
      if (gate === 'slot') ctx.gates.slot = false;
    }
    return finish();
  };

  const lock = L.acquireLock();
  if (!lock.ok) { log(`outra execução do e2e em andamento (pid ${lock.pid}) — abortando`); process.exit(2); }
  const cleanup = async () => {
    if (ctx.sessionKey && !flags.keepSession) await L.openclaw(['sessions', 'delete', ctx.sessionKey, '--yes', '--json'], 15000).catch(() => {});
    L.releaseLock();
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { log(`\n${sig}: limpando…`); await cleanup(); process.exit(2); });

  log(`E2E real — mythos ${ctx.baseUrl} — primário ${ctx.primaryRaw || '?'} — ${new Date(ctx.startedAt).toISOString()}`);
  log(`${'LAYER'.padEnd(9)} ${'ID'.padEnd(16)} ${'RESULT'.padEnd(5)} ${'TIME'.padStart(7)}  REASON`);

  try {
    await checks.preflight(ctx);
    await checks.backend(ctx);
    await checks.gateway(ctx);
  } finally {
    await cleanup();
  }

  const n = s => ctx.results.filter(r => r.status === s).length;
  const fails = n('FAIL'), skips = n('SKIP'), passes = n('PASS');
  const durationMs = Date.now() - ctx.startedAt;
  // Exit 2 só quando o motivo é "inconclusivo" (slot/orçamento) e não houve FAIL fora do pre.slot.
  const slotOnly = ctx.results.every(r => r.status !== 'FAIL' || r.id === 'pre.slot');
  const exitCode = fails && !(ctx.blocked && slotOnly) ? 1 : (ctx.blocked ? 2 : 0);
  const verdict = exitCode === 0 ? 'OK' : exitCode === 1 ? 'FAIL' : 'INCONCLUSIVO';
  log(`RESULT: ${verdict} — ${passes} pass, ${fails} fail, ${skips} skip — ${L.fmtMs(durationMs)} — tokens /v1: ${ctx.tokens}${ctx.blocked ? ` — ${ctx.blocked}` : ''}`);

  if (flags.json) {
    const doc = { ok: exitCode === 0, exitCode, verdict, startedAt: new Date(ctx.startedAt).toISOString(), durationMs, target: { baseUrl: ctx.baseUrl, primaryModel: ctx.primaryRaw }, tokens: ctx.tokens, blocked: ctx.blocked, summary: { pass: passes, fail: fails, skip: skips }, steps: ctx.results };
    process.stdout.write(L.redact(JSON.stringify(doc, null, 2)) + '\n');
  }
  process.exit(exitCode);
}

main().catch(async err => { console.error(L.redact(`erro inesperado: ${err.stack || err.message}`)); L.releaseLock(); process.exit(1); });
