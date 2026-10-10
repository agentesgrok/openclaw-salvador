// TaxLife scraper — Puppeteer client com login persistente.
//
// Estratégia:
//   1. Se ~/.taxlife/storage_state.json existe e não expirou → reusa cookies
//   2. Senão → loga via form local com email+senha (TAXLIFE_PASSWORD)
//   3. Salva storage_state pós-login pra próxima execução
//
// Login local (form HTML), NÃO OAuth Google — evita 2FA e desafios anti-bot.
//
// Env vars (ver .env.example):
//   TAXLIFE_BASE_URL       https://www.novotributariotaxlife.com.br
//   TAXLIFE_EMAIL          lucas@lucasjuridico.com
//   TAXLIFE_PASSWORD       senha local da plataforma (não da conta Google)
//   TAXLIFE_STORAGE_STATE  /home/jarvis/.taxlife/storage_state.json
//   TAXLIFE_HEADLESS       'true' (default) | 'false' pra debug visual

const fs = require('fs').promises;
const path = require('path');

const DEFAULTS = {
  baseUrl:      'https://www.novotributariotaxlife.com.br',
  storageState: path.join(process.env.HOME || '/home/jarvis', '.taxlife/storage_state.json'),
  headless:     true,
  // Cookies TTL conservador — após N horas reloga mesmo se cookies "parecem" válidos.
  cookieMaxAgeMs: 12 * 60 * 60 * 1000,
};

function _cfg() {
  return {
    baseUrl:        process.env.TAXLIFE_BASE_URL    || DEFAULTS.baseUrl,
    email:          process.env.TAXLIFE_EMAIL       || '',
    password:       process.env.TAXLIFE_PASSWORD    || '',
    storageState:   process.env.TAXLIFE_STORAGE_STATE || DEFAULTS.storageState,
    headless:       process.env.TAXLIFE_HEADLESS !== 'false',
    cookieMaxAgeMs: DEFAULTS.cookieMaxAgeMs,
  };
}

async function _loadStorageState(cfg) {
  try {
    const raw = await fs.readFile(cfg.storageState, 'utf8');
    const state = JSON.parse(raw);
    const ageMs = Date.now() - (state._savedAt || 0);
    if (ageMs > cfg.cookieMaxAgeMs) {
      return { state: null, reason: `storage_state expirado (${Math.round(ageMs / 60000)}min)` };
    }
    return { state, reason: null };
  } catch (err) {
    if (err.code === 'ENOENT') return { state: null, reason: 'storage_state inexistente' };
    return { state: null, reason: 'storage_state corrompido: ' + err.message };
  }
}

async function _saveStorageState(cfg, page) {
  const cookies = await page.cookies();
  const origin = new URL(cfg.baseUrl).origin;
  const localStorage = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      out[k] = window.localStorage.getItem(k);
    }
    return out;
  }).catch(() => ({}));
  const state = {
    _savedAt: Date.now(),
    _origin: origin,
    cookies,
    localStorage,
  };
  await fs.mkdir(path.dirname(cfg.storageState), { recursive: true, mode: 0o700 });
  await fs.writeFile(cfg.storageState, JSON.stringify(state, null, 2), { mode: 0o600 });
  return { ok: true, path: cfg.storageState, cookies: cookies.length, lsKeys: Object.keys(localStorage).length };
}

async function _applyStorageState(page, state) {
  if (!state || !state.cookies) return;
  if (state.cookies.length) await page.setCookie(...state.cookies);
  // localStorage precisa ser aplicado APÓS goto da origem certa
}

async function _applyLocalStorage(page, state) {
  if (!state || !state.localStorage) return;
  const ls = state.localStorage;
  await page.evaluate((items) => {
    for (const [k, v] of Object.entries(items)) {
      try { window.localStorage.setItem(k, v); } catch {}
    }
  }, ls);
}

async function _isLoggedIn(page) {
  const url = page.url();
  const u = url.toLowerCase();
  // Rotas de login conhecidas — se está nelas, NÃO logado.
  if (/\/(auth|login|signin)(\/|$|\?)/.test(u)) return false;
  // Se URL é a home autenticada ou rota interna conhecida, considera logado.
  // Lovable redireciona pra /auth se não autenticado, então estar fora de /auth
  // já é forte sinal de sessão válida.
  return true;
}

/**
 * Loga via form local. Funciona DEPOIS de a página /auth ter carregado.
 * @returns {{ ok: boolean, url: string, error?: string }}
 */
async function _doLocalLogin(page, cfg) {
  if (!cfg.email || !cfg.password) {
    return { ok: false, url: page.url(), error: 'TAXLIFE_EMAIL e TAXLIFE_PASSWORD obrigatórios' };
  }

  // Form local — selectors confirmados pelo HTML real (input id="email", input id="password")
  await page.waitForSelector('input#email, input[type="email"]', { timeout: 10000 });
  await page.waitForSelector('input#password, input[type="password"]', { timeout: 10000 });

  await page.click('input#email, input[type="email"]', { clickCount: 3 });
  await page.type('input#email, input[type="email"]', cfg.email, { delay: 25 });

  await page.click('input#password, input[type="password"]', { clickCount: 3 });
  await page.type('input#password, input[type="password"]', cfg.password, { delay: 25 });

  // Botão "Entrar" (submit do form, NÃO o "Entrar com Google")
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button[type="submit"]'));
    const entrar = buttons.find(b => /^Entrar$|^Entrar\s/i.test((b.textContent || '').trim()));
    if (entrar) entrar.click();
    else if (buttons[0]) buttons[0].click();
  });

  // Espera nav OU mensagem de erro
  await new Promise(r => setTimeout(r, 7000));

  const finalUrl = page.url();
  const errorText = await page.evaluate(() => {
    const sel = '[role="alert"], [data-sonner-toast], .text-destructive, .text-red-500';
    const el = document.querySelector(sel);
    return el ? el.textContent.trim().slice(0, 200) : null;
  }).catch(() => null);

  if (errorText) return { ok: false, url: finalUrl, error: errorText };
  if (finalUrl.includes('/auth') || finalUrl.includes('/login')) {
    return { ok: false, url: finalUrl, error: 'ainda na página de login após submit' };
  }

  return { ok: true, url: finalUrl };
}

/**
 * Cria browser + page autenticada. Retorna { browser, page, cfg, freshLogin }.
 * Caller é responsável por chamar `await browser.close()` no fim.
 */
async function authenticatedPage() {
  const puppeteer = require('puppeteer');
  const cfg = _cfg();
  const startedAt = Date.now();

  const browser = await puppeteer.launch({
    headless: cfg.headless ? 'new' : false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/120.0.0.0 Safari/537.36'
  );

  // 1. Tenta storage_state existente
  const { state, reason } = await _loadStorageState(cfg);
  let freshLogin = false;
  let loginInfo = null;

  if (state) {
    // Cookies aplicados antes da 1ª navegação
    await _applyStorageState(page, state);
    // 1ª navegação pra origem dummy (about:blank não tem localStorage da origem alvo;
    // navegar pra /auth pra ter origem correta sem disparar redirect logo de cara)
    await page.goto(cfg.baseUrl + '/auth', { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Agora aplica localStorage na origem correta
    await _applyLocalStorage(page, state);
    // Goto final pra home — Supabase JS vai ler o token do localStorage e validar sessão
    await page.goto(cfg.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000)); // Supabase faz refresh do token (network call)
    if (await _isLoggedIn(page)) {
      return { browser, page, cfg, freshLogin: false, loadMs: Date.now() - startedAt, loginInfo: { reused: true, reason: 'storage_state válido' } };
    }
    // Cookies/localStorage expiraram → tenta login fresh
    loginInfo = { reused: false, reason: 'storage_state inválido (Supabase rejeitou)' };
  } else {
    loginInfo = { reused: false, reason };
  }

  // 2. Login fresh
  await page.goto(cfg.baseUrl + '/auth', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500)); // hidrate SPA
  const result = await _doLocalLogin(page, cfg);
  if (!result.ok) {
    await browser.close();
    const err = new Error('TaxLife login falhou: ' + (result.error || 'unknown'));
    err.url = result.url;
    err.loginInfo = loginInfo;
    throw err;
  }

  freshLogin = true;
  const saved = await _saveStorageState(cfg, page);
  return { browser, page, cfg, freshLogin, loadMs: Date.now() - startedAt, loginInfo: { ...loginInfo, freshLogin: true, saved } };
}

/**
 * Healthcheck: tenta autenticar e retorna info pública (sem expor cookies).
 */
async function healthcheck() {
  const startedAt = Date.now();
  let browser;
  try {
    const r = await authenticatedPage();
    browser = r.browser;
    const url = r.page.url();
    const title = await r.page.title();
    const links = await r.page.evaluate(() => {
      const set = new Set();
      document.querySelectorAll('a[href]').forEach(a => {
        const h = a.getAttribute('href');
        if (h && h.startsWith('/')) set.add(h.split('?')[0]);
      });
      return Array.from(set).slice(0, 30);
    });
    return {
      ok: true,
      url,
      title,
      freshLogin: r.freshLogin,
      loginInfo: r.loginInfo,
      visibleLinks: links,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      url: err.url || null,
      loginInfo: err.loginInfo || null,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = {
  authenticatedPage,
  healthcheck,
  _cfg,
};
