// Self-scan de segurança do mythos backend.
//
// Roda 5 checks runtime + estáticos sobre o próprio código + env + deps.
// Cobre o que conhecemos da superfície atual; NÃO substitui DAST (OWASP ZAP) nem SAST (Semgrep).
//
// Filosofia:
// - Cada check retorna { id, severity, passed, found: [...], details }
// - Cron monitor pode rodar toda semana e alertar se contagem de issues subir

const fs = require('fs-extra');
const path = require('path');
const { spawnSync } = require('child_process');

const SERVER_JS = path.join(__dirname, '../../server.js');
const PACKAGE_JSON = path.join(__dirname, '../../package.json');

// Endpoints intencionalmente públicos (sem requireAuth). Ajustar com cuidado.
const AUTH_WHITELIST = [
  '/api/health',                    // liveness probe
  '/api/debug/session/:sessionId',  // requireDevMode
  '/api/debug/dialogs',             // requireDevMode
];

// ─── Check 1: auth coverage ─────────────────────────────────────────────────
async function checkAuthCoverage() {
  const src = await fs.readFile(SERVER_JS, 'utf8');
  const lines = src.split('\n');
  const findings = [];
  const routeRe = /^app\.(get|post|put|delete|patch)\(['"]([^'"]+)['"]/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(routeRe);
    if (!m) continue;
    const [, method, route] = m;
    if (AUTH_WHITELIST.includes(route)) continue;

    // Look ahead até 5 linhas pra ver se tem requireAuth ou requireDevMode
    const ahead = lines.slice(i, i + 6).join('\n');
    if (ahead.includes('requireAuth') || ahead.includes('requireDevMode')) continue;

    findings.push({ method: method.toUpperCase(), path: route, line: i + 1 });
  }

  return {
    id: 'auth-coverage',
    severity: findings.length > 0 ? 'high' : 'info',
    passed: findings.length === 0,
    found: findings,
    details: `${findings.length} endpoints sem auth check fora da whitelist. Whitelist: ${AUTH_WHITELIST.join(', ')}.`,
  };
}

// ─── Check 2: stack trace em response ───────────────────────────────────────
async function checkStackTraceLeak() {
  const findings = [];
  const targets = [SERVER_JS];
  // Adicionar handlers se quiser estender — server.js cobre 90% do risk surface.

  for (const file of targets) {
    if (!await fs.pathExists(file)) continue;
    const src = await fs.readFile(file, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // Padrão clássico: res.json({ ..., stack: err.stack ... }) ou res.send(err.stack)
      if (/res\.(json|send|status\([^)]*\)\.json)\s*\(\s*\{[^}]*stack\s*:\s*err\.stack/.test(lines[i])
          || /res\.(json|send|status\([^)]*\)\.json)\s*\(\s*err\.stack/.test(lines[i])) {
        findings.push({ file: path.relative(path.join(__dirname, '../..'), file), line: i + 1, snippet: lines[i].trim().slice(0, 120) });
      }
    }
  }

  return {
    id: 'stack-trace-leak',
    severity: findings.length > 0 ? 'high' : 'info',
    passed: findings.length === 0,
    found: findings,
    details: 'CWE-209 — stack traces em response body vazam paths/versão/módulos. Manter no log do servidor, não no response.',
  };
}

// ─── Check 3: upload size limit ─────────────────────────────────────────────
async function checkUploadSizeLimit() {
  const src = await fs.readFile(SERVER_JS, 'utf8');
  const findings = [];

  // Procura `multer({` sem `limits:` no escopo de até 10 linhas
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/multer\s*\(\s*\{/.test(lines[i])) {
      const block = lines.slice(i, i + 15).join('\n');
      if (!/limits\s*:/.test(block)) {
        findings.push({ line: i + 1, reason: 'multer sem limits.fileSize — DoS por arquivo grande' });
      }
    }
  }

  return {
    id: 'upload-size-limit',
    severity: findings.length > 0 ? 'medium' : 'info',
    passed: findings.length === 0,
    found: findings,
    details: 'multer com limits.fileSize: N protege contra arquivos gigantes esgotando memória.',
  };
}

// ─── Check 4: env misconfig ─────────────────────────────────────────────────
function checkEnvMisconfig() {
  const findings = [];

  const apiSecret = process.env.API_SECRET || process.env.WEBHOOK_CRM_SECRET;
  if (!apiSecret) {
    findings.push({ key: 'API_SECRET', reason: 'ausente — requireAuth retorna 500 em qualquer request' });
  } else if (apiSecret.length < 32) {
    findings.push({ key: 'API_SECRET', reason: `length=${apiSecret.length} (recomendado >= 32 chars, gere com 'openssl rand -hex 32')` });
  }
  if (!process.env.API_SECRET && process.env.WEBHOOK_CRM_SECRET) {
    findings.push({ key: 'WEBHOOK_CRM_SECRET', reason: 'nome antigo — renomear para API_SECRET no .env' });
  }

  if (!process.env.LLM_PROXY_API_KEY) {
    findings.push({ key: 'LLM_PROXY_API_KEY', reason: 'ausente — /v1/* cai no fallback API_SECRET (escopo único pra REST e LLM proxy)' });
  } else if (process.env.LLM_PROXY_API_KEY.length < 32) {
    findings.push({ key: 'LLM_PROXY_API_KEY', reason: `length=${process.env.LLM_PROXY_API_KEY.length} (recomendado >= 32 chars)` });
  }

  if (apiSecret && process.env.LLM_PROXY_API_KEY && apiSecret === process.env.LLM_PROXY_API_KEY) {
    findings.push({ key: 'API_SECRET/LLM_PROXY_API_KEY', reason: 'mesmo valor — escopos colapsados, revogação afeta os 2' });
  }

  return {
    id: 'env-misconfig',
    severity: findings.some(f => f.key === 'API_SECRET') ? 'high' : 'medium',
    passed: findings.length === 0,
    found: findings,
    details: 'Verifica secrets fortes e escopos separados (REST vs LLM proxy).',
  };
}

// ─── Check 5: npm audit (subprocess, melhor-esforço) ────────────────────────
async function checkNpmAudit() {
  const findings = [];
  let auditError = null;

  try {
    const result = spawnSync('npm', ['audit', '--json'], {
      cwd: path.join(__dirname, '../..'),
      encoding: 'utf-8',
      timeout: 30000,
    });

    if (result.error) {
      auditError = `spawn falhou: ${result.error.message}`;
    } else if (!result.stdout) {
      auditError = 'npm audit sem stdout';
    } else {
      const json = JSON.parse(result.stdout);
      const v = (json.metadata && json.metadata.vulnerabilities) || {};
      const high = (v.high || 0) + (v.critical || 0);
      const moderate = v.moderate || 0;
      const low = v.low || 0;

      if (high > 0) findings.push({ severity_count: 'high+critical', count: high, ...v });
      if (moderate > 0) findings.push({ severity_count: 'moderate', count: moderate });
      if (low > 0) findings.push({ severity_count: 'low', count: low });
    }
  } catch (err) {
    auditError = err.message;
  }

  const hasHigh = findings.some(f => f.severity_count === 'high+critical');
  return {
    id: 'npm-audit',
    severity: hasHigh ? 'high' : (findings.length > 0 ? 'medium' : 'info'),
    passed: !hasHigh,
    found: findings,
    auditError,
    details: 'Roda `npm audit --json` no backend. high+critical falham assert; moderate/low ficam como info.',
  };
}

// ─── Aggregator ─────────────────────────────────────────────────────────────
async function runScan() {
  const startedAt = Date.now();
  const checks = await Promise.all([
    checkAuthCoverage(),
    checkStackTraceLeak(),
    checkUploadSizeLimit(),
    Promise.resolve(checkEnvMisconfig()),
    checkNpmAudit(),
  ]);

  const summary = {
    total: checks.length,
    passed: checks.filter(c => c.passed).length,
    failed: checks.filter(c => !c.passed).length,
    by_severity: {
      high: checks.filter(c => !c.passed && c.severity === 'high').length,
      medium: checks.filter(c => !c.passed && c.severity === 'medium').length,
      low: checks.filter(c => !c.passed && c.severity === 'low').length,
      info: checks.filter(c => !c.passed && c.severity === 'info').length,
    },
    total_findings: checks.reduce((acc, c) => acc + (c.found ? c.found.length : 0), 0),
  };

  return {
    ok: true,
    ts: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    summary,
    checks,
    disclaimer: 'self-scan cobre só checks que conhecemos. Não substitui DAST (OWASP ZAP) nem SAST (Semgrep/CodeQL).',
  };
}

module.exports = { runScan };
