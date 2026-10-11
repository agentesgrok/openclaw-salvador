// tests/e2e/lib.js — helpers do e2e real (sem dependências além do Node 24).
//
// Regras:
//  - segredos (chaves do .env, apiKey do openclaw.json, --bearer) entram em `secrets`
//    e TODA saída passa por redact(); comparações são feitas em código, nunca impressas.
//  - nenhum helper escreve em estado do backend/gateway; o único efeito colateral é a
//    sessão descartável do gateway (criada/apagada pelo runner) e o lock file.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BACKEND_DIR = path.resolve(__dirname, '..', '..');
const LOCK_FILE = path.join(BACKEND_DIR, 'data', 'e2e.lock');
const LOCK_STALE_MS = 15 * 60 * 1000;

// ── Segredos / redação ──

const secrets = new Set();
function addSecret(v) { if (v && typeof v === 'string' && v.length >= 8) secrets.add(v); }
function redact(text) {
  let out = String(text ?? '');
  for (const s of secrets) out = out.split(s).join('***');
  return out;
}

// ── .env do backend (parser mínimo KEY=value; não toca process.env) ──

function parseEnvFile(file) {
  const out = {};
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function loadBackendEnv() {
  const env = parseEnvFile(path.join(BACKEND_DIR, '.env'));
  for (const k of ['LLM_PROXY_API_KEY', 'API_SECRET', 'WEBHOOK_CRM_SECRET', 'GUIMOO_API_KEY']) addSecret(env[k]);
  return env;
}

// ── Processos externos ──

function run(cmd, args, { timeoutMs = 30000, cwd, env } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, finished = false;
    const child = spawn(cmd, args, { cwd, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => { if (!finished) child.kill('SIGKILL'); }, 5000).unref();
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { finished = true; clearTimeout(killer); resolve({ code: -1, stdout, stderr: stderr + err.message, timedOut, error: err }); });
    child.on('close', code => { finished = true; clearTimeout(killer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

const openclaw = (args, timeoutMs = 30000) => run('openclaw', args, { timeoutMs });

// Lê um valor do config do OpenClaw pelo CLI (evita parsear o JSON na mão).
async function openclawConfigGet(key, timeoutMs = 15000) {
  const r = await openclaw(['config', 'get', key], timeoutMs);
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch { /* tenta a partir do primeiro { ou [ */ }
  const i = Math.min(...['{', '['].map(c => { const k = text.indexOf(c); return k < 0 ? Infinity : k; }));
  if (!Number.isFinite(i)) return null;
  try { return JSON.parse(text.slice(i)); } catch { return null; }
}

// ── HTTP ──

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 10000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* não-JSON */ }
  return { status: res.status, contentType: res.headers.get('content-type') || '', json, text };
}

// Consome um SSE OpenAI até `data: [DONE]`. Devolve os chunks parseados e o texto concatenado.
async function fetchSse(url, { headers = {}, body, timeoutMs = 120000 } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const contentType = res.headers.get('content-type') || '';
  if (!res.body || !contentType.startsWith('text/event-stream')) {
    const text = await res.text();
    return { status: res.status, contentType, chunks: [], text: '', gotDone: false, raw: text };
  }
  const chunks = [];
  let buffer = '', text = '', gotDone = false, usage = null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') { gotDone = true; continue; }
        try {
          const j = JSON.parse(payload);
          chunks.push(j);
          const delta = j.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') text += delta;
          if (j.usage) usage = j.usage;
        } catch { /* ignora frame malformado */ }
      }
    }
    if (gotDone) break;
  }
  try { await reader.cancel(); } catch { /* já encerrado */ }
  return { status: res.status, contentType, chunks, text, gotDone, usage };
}

function tcpConnect(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const t = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.on('connect', () => { clearTimeout(t); sock.end(); resolve(true); });
    sock.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

// ── Lock (uma execução por vez: um turno ocupa o único slot do CLI) ──

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    const fresh = Date.now() - cur.startedAt < LOCK_STALE_MS;
    let alive = false;
    try { process.kill(cur.pid, 0); alive = true; } catch { alive = false; }
    if (fresh && alive) return { ok: false, pid: cur.pid };
  } catch { /* sem lock ou ilegível */ }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  return { ok: true };
}
function releaseLock() {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (cur.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch { /* nada */ }
}

// ── Log do gateway: só CONTA marcadores numa janela; nunca devolve linhas (contém PII) ──

const MARKERS = {
  fallback: /"event":"(model_fallback_decision|embedded_run_failover_decision)"/,
  mythosError: /provider=mythos[^\n]*(ECONNREFUSED|fetch failed|401|5\d\d)/,
  agentError: /"event":"embedded_run_agent_end"[^\n]*"isError":true/,
  allFailed: /All models failed/,
};

function gatewayLogFiles(t0, t1) {
  const days = new Set([new Date(t0).toISOString().slice(0, 10), new Date(t1).toISOString().slice(0, 10)]);
  return [...days].map(d => `/tmp/openclaw/openclaw-${d}.log`).filter(f => fs.existsSync(f));
}

function countGatewayMarkers(t0, t1) {
  const counts = Object.fromEntries(Object.keys(MARKERS).map(k => [k, 0]));
  const files = gatewayLogFiles(t0, t1);
  if (!files.length) return { counts, source: 'none' };
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const m = line.match(/"date":"([^"]+)"/);
      if (!m) continue;
      const ts = Date.parse(m[1]);
      if (!(ts >= t0 && ts <= t1)) continue;
      for (const [k, re] of Object.entries(MARKERS)) if (re.test(line)) counts[k]++;
    }
  }
  return { counts, source: 'file' };
}

// ── Utilidades ──

function pickFirst(obj, paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function firstArray(obj) {
  if (Array.isArray(obj)) return obj;
  if (obj && typeof obj === 'object') for (const v of Object.values(obj)) if (Array.isArray(v)) return v;
  return [];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtMs = ms => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

module.exports = {
  BACKEND_DIR, LOCK_FILE,
  addSecret, redact, loadBackendEnv, parseEnvFile,
  run, openclaw, openclawConfigGet, parseJsonLoose,
  fetchJson, fetchSse, tcpConnect,
  acquireLock, releaseLock,
  countGatewayMarkers, MARKERS,
  pickFirst, firstArray, sleep, fmtMs, os,
};
