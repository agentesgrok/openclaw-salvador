// TaxLife inventário — mapeia áreas autenticadas (tracks, news, tools, etc).
//
// 2 níveis de profundidade:
//   Pass 1: lista raiz da área (ex: /tracks → todas as trilhas)
//   Pass 2 (opcional): aprofunda 1 nível (entra em cada trilha → lista cursos/aulas)
//
// Resultado é JSON estruturado pronto pra alimentar NotebookLM.

const { authenticatedPage } = require('./client');

/**
 * Extrai do DOM atual: títulos visíveis, cards com link, imagens, descrições.
 * Heurísticas pra plataforma Lovable (semantic HTML padrão).
 */
async function _extractCards(page) {
  return await page.evaluate(() => {
    const out = [];

    // Heurística 1: div.cursor-pointer (padrão Lovable — cards SPA sem <a> wrapper).
    // Cada card tem heading interno + metadata textual + (opcional) imagem.
    const sel1 = document.querySelectorAll('div.cursor-pointer, [role="button"]');
    sel1.forEach((el, idx) => {
      const heading = el.querySelector('h1, h2, h3, h4, h5');
      const title = (heading?.textContent || '').trim();
      if (!title || title.length < 3 || title.length > 200) return;
      const allText = (el.innerText || el.textContent || '').trim();
      // Snippet curto sem o título duplicado
      const snippet = allText.replace(title, '').replace(/\s+/g, ' ').trim().slice(0, 500);
      const img = el.querySelector('img');
      const imageSrc = img ? (img.getAttribute('src') || img.getAttribute('data-src') || '') : null;
      // Tenta inferir autor (texto "COM XXX")
      const autorMatch = allText.match(/COM\s+([A-ZÁÊÔÃÕÉÍÓÚÇa-záêôãõéíóúç\s]+?)(?:\n|$)/);
      const autor = autorMatch ? autorMatch[1].trim().slice(0, 80) : null;
      // Heurística pra status — palavras-chave conhecidas
      const status = (() => {
        if (/em breve|disponível em/i.test(allText)) return 'em-breve';
        if (/em andamento/i.test(allText)) return 'em-andamento';
        if (/assistir agora|continuar/i.test(allText)) return 'disponivel';
        return null;
      })();
      // Métricas (alunos, aulas)
      const alunosMatch = allText.match(/([\d.,]+)\s*alunos/i);
      const aulasMatch = allText.match(/(\d+)\s*aulas/i);
      out.push({
        kind: 'spa-card',
        idx,
        title,
        autor,
        status,
        alunos: alunosMatch ? alunosMatch[1] : null,
        aulas: aulasMatch ? Number(aulasMatch[1]) : null,
        snippet,
        imageSrc,
        // selector pra ser usado em pass 2 (clicar no card)
        // Lovable não dá id estável; idx ordinal serve
        clickIdx: idx,
      });
    });

    // Heurística 2: <a href> tradicional (caso outras áreas usem)
    const sel2 = Array.from(document.querySelectorAll('a[href]'));
    for (const a of sel2) {
      const href = a.getAttribute('href') || '';
      if (!href.startsWith('/') || href === '/' || href.startsWith('//')) continue;
      const heading = a.querySelector('h1, h2, h3, h4, h5');
      const title = (heading?.textContent || '').trim();
      if (!title || title.length < 3 || title.length > 200) continue;
      out.push({ kind: 'href', href, title });
    }

    // Dedup por (kind, idx/href, title)
    const seen = new Set();
    return out.filter(c => {
      const k = `${c.kind}|${c.idx ?? c.href}|${c.title}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });
}

async function _extractHeadings(page) {
  return await page.evaluate(() => {
    const out = {};
    for (const tag of ['h1', 'h2', 'h3']) {
      const els = Array.from(document.querySelectorAll(tag));
      out[tag] = els
        .map(e => (e.textContent || '').trim())
        .filter(t => t && t.length < 200)
        .slice(0, 20);
    }
    return out;
  });
}

async function _extractText(page, maxChars = 5000) {
  return await page.evaluate((cap) => {
    const main = document.querySelector('main') || document.body;
    return (main.innerText || '').trim().slice(0, cap);
  }, maxChars);
}

/**
 * Mapeia 1 área (path como '/tracks', '/news', etc).
 * @param {Page} page
 * @param {string} baseUrl
 * @param {string} path
 * @param {object} opts
 * @returns {object} { path, url, title, headings, cards, text? }
 */
async function _mapArea(page, baseUrl, path, opts = {}) {
  const url = baseUrl + path;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Aguarda hidratação SPA — espera até ter conteúdo significativo OU 8s
  await page.waitForFunction(() => {
    const headings = document.querySelectorAll('h1, h2, h3').length;
    const cards = document.querySelectorAll('a[href]').length;
    // Considera hidratado quando tem pelo menos 1 heading OU >= 5 anchors
    return headings >= 1 || cards >= 5;
  }, { timeout: 8000 }).catch(() => {});

  // Buffer extra pra animações/lazy-load
  await new Promise(r => setTimeout(r, 2500));

  const finalUrl = page.url();
  const title = await page.title();
  const headings = await _extractHeadings(page);
  const cards = await _extractCards(page);
  const out = { path, url: finalUrl, title, headings, cards: cards.slice(0, opts.cardLimit || 100) };
  if (opts.includeText) {
    out.text = await _extractText(page, opts.textCap || 5000);
  }
  if (opts.includeHtml) {
    out.html = await page.content();
  }
  return out;
}

/**
 * Inventário Pass 1: mapeia áreas raiz informadas (default: tracks + news).
 * Não aprofunda — só lista o que aparece em cada área.
 *
 * @param {object} opts
 * @param {string[]} opts.areas — paths a mapear (default ['/tracks', '/news'])
 * @param {boolean} opts.includeText — capturar innerText (default false)
 * @param {number} opts.cardLimit — max de cards por área (default 100)
 */
async function inventarioRaiz(opts = {}) {
  const areas = opts.areas || ['/tracks', '/news'];
  const startedAt = Date.now();
  let browser;
  try {
    const r = await authenticatedPage();
    browser = r.browser;

    const result = {
      ok: true,
      freshLogin: r.freshLogin,
      areas: [],
      durationMs: 0,
    };

    for (const path of areas) {
      try {
        const map = await _mapArea(r.page, r.cfg.baseUrl, path, opts);
        result.areas.push(map);
      } catch (err) {
        result.areas.push({ path, error: err.message });
      }
    }

    result.durationMs = Date.now() - startedAt;
    return result;
  } catch (err) {
    return { ok: false, error: err.message, durationMs: Date.now() - startedAt };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Inventário Pass 2: aprofunda em N hrefs descobertos no Pass 1.
 * Útil pra entrar em uma trilha específica e listar cursos/aulas dela.
 *
 * @param {object} opts
 * @param {string[]} opts.hrefs — paths absolutos (ex: ['/tracks/abc', '/tracks/def'])
 * @param {boolean} opts.includeText — captura texto (default true pra Pass 2)
 * @param {number} opts.maxHrefs — limite de segurança (default 10)
 */
async function aprofundarHrefs(opts = {}) {
  const hrefs = (opts.hrefs || []).slice(0, opts.maxHrefs || 10);
  if (!hrefs.length) return { ok: false, error: 'hrefs obrigatório' };

  const startedAt = Date.now();
  let browser;
  try {
    const r = await authenticatedPage();
    browser = r.browser;

    const result = { ok: true, freshLogin: r.freshLogin, items: [], durationMs: 0 };
    for (const href of hrefs) {
      try {
        const map = await _mapArea(r.page, r.cfg.baseUrl, href, {
          includeText: opts.includeText !== false, // default true
          textCap: opts.textCap || 8000,
          cardLimit: 60,
        });
        result.items.push(map);
      } catch (err) {
        result.items.push({ path: href, error: err.message });
      }
    }
    result.durationMs = Date.now() - startedAt;
    return result;
  } catch (err) {
    return { ok: false, error: err.message, durationMs: Date.now() - startedAt };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = {
  inventarioRaiz,
  aprofundarHrefs,
};
