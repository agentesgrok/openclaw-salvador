// TaxLife extractor — entra em 1 curso e extrai estrutura interna.
//
// Lovable/React não usa <a href> nos cards de curso (apenas <div class="cursor-pointer">
// com onClick handler React). Pra entrar num curso, precisa CLICAR via Puppeteer
// e capturar a URL pós-navegação. Não dá pra inferir só do HTML.
//
// Output:
//   {
//     titulo, autor, status, alunos, aulas (count from inventario),
//     url: "https://...path/real/do/curso",
//     modulos: [
//       { titulo, aulas: [{ titulo, texto, pdfUrls: [...], videoUrls: [...] }] }
//     ],
//     extractedAt: ISO,
//     rawCardSnapshot: { ... }    // referência do card antes do clique
//   }

const { authenticatedPage } = require('./client');
const { inventarioRaiz } = require('./inventario');

/**
 * Extrai estrutura interna de 1 curso.
 *
 * @param {object} opts
 * @param {number} opts.clickIdx       — idx ordinal retornado pelo inventarioRaiz (campo c.clickIdx)
 * @param {string} opts.titleMatch     — alternativa: substring case-insensitive do título
 * @param {string} opts.area           — onde procurar o curso (default '/tracks')
 * @param {boolean} opts.includeRawHtml — devolve HTML cru pra debug (default false)
 * @returns {object} curso extraído (estrutura no topo do arquivo)
 */
async function extrairCurso(opts = {}) {
  const startedAt = Date.now();
  const area = opts.area || '/tracks';
  let browser;

  try {
    const r = await authenticatedPage();
    browser = r.browser;
    const page = r.page;

    // 1. Navega pra área e espera renderização
    await page.goto(r.cfg.baseUrl + area, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => {
      return document.querySelectorAll('div.cursor-pointer').length >= 5;
    }, { timeout: 12000 }).catch(() => {});
    await new Promise(res => setTimeout(res, 2000));

    // 2. Localiza card alvo via clickIdx ou titleMatch
    const targetCard = await page.evaluate((sel) => {
      const cards = Array.from(document.querySelectorAll('div.cursor-pointer'));
      let target;
      if (typeof sel.clickIdx === 'number') {
        target = cards[sel.clickIdx];
      } else if (sel.titleMatch) {
        const needle = sel.titleMatch.toLowerCase();
        target = cards.find(c => {
          const h = c.querySelector('h1, h2, h3, h4, h5');
          return h && (h.textContent || '').toLowerCase().includes(needle);
        });
      }
      if (!target) return null;
      // Snapshot do card antes do clique
      const heading = target.querySelector('h1, h2, h3, h4, h5');
      const allText = (target.innerText || '').trim();
      const autorMatch = allText.match(/COM\s+([A-ZÁÊÔÃÕÉÍÓÚÇa-záêôãõéíóúç\s]+?)(?:\n|$)/);
      return {
        index: cards.indexOf(target),
        title: (heading?.textContent || '').trim(),
        autor: autorMatch ? autorMatch[1].trim() : null,
        snippet: allText.slice(0, 400),
      };
    }, { clickIdx: opts.clickIdx, titleMatch: opts.titleMatch });

    if (!targetCard) {
      throw new Error(`card não encontrado (clickIdx=${opts.clickIdx}, titleMatch=${opts.titleMatch})`);
    }

    // 3. Clica e aguarda navegação
    const urlBefore = page.url();
    await page.evaluate((idx) => {
      const cards = Array.from(document.querySelectorAll('div.cursor-pointer'));
      cards[idx].click();
    }, targetCard.index);

    // Aguarda mudança de URL ou aparecimento de elementos do curso
    try {
      await page.waitForFunction((before) => {
        return location.href !== before;
      }, { timeout: 15000 }, urlBefore);
    } catch (_) {
      // URL pode não mudar se Lovable usar pseudo-routing por modal — segue
    }
    await new Promise(res => setTimeout(res, 2500));
    await page.waitForFunction(() => {
      return document.querySelectorAll('h1, h2, h3').length >= 1;
    }, { timeout: 8000 }).catch(() => {});

    const urlAfter = page.url();

    // 4. Extrai estrutura do curso (módulos + aulas)
    const cursoData = await page.evaluate(() => {
      const out = {
        titulo: null,
        descricao: null,
        modulos: [],
        rawText: '',
        pdfUrls: [],
        videoUrls: [],
      };

      // Título principal
      const h1 = document.querySelector('h1');
      out.titulo = h1 ? (h1.textContent || '').trim() : null;

      // Descrição (primeiro <p> próximo do h1)
      const descEl = document.querySelector('main p, [class*="description"]');
      out.descricao = descEl ? (descEl.textContent || '').trim().slice(0, 500) : null;

      // Texto cru do main
      const main = document.querySelector('main') || document.body;
      out.rawText = (main.innerText || '').trim().slice(0, 30000);

      // Heurística pra módulos: h2/h3 + lista de aulas debaixo
      // Lovable costuma usar accordions — cada módulo é um <button> ou <details>
      // Estratégia v1: agrupar h2/h3 com seus h4/h5 abaixo até próximo h2/h3
      const headings = Array.from(main.querySelectorAll('h2, h3, h4, h5'));
      let currentMod = null;
      for (const h of headings) {
        const tag = h.tagName.toLowerCase();
        const text = (h.textContent || '').trim();
        if (!text || text.length > 200) continue;
        if (tag === 'h2' || tag === 'h3') {
          // Novo módulo
          if (currentMod) out.modulos.push(currentMod);
          currentMod = { titulo: text, aulas: [] };
        } else if (currentMod && (tag === 'h4' || tag === 'h5')) {
          currentMod.aulas.push({ titulo: text, texto: null, pdfUrls: [], videoUrls: [] });
        }
      }
      if (currentMod) out.modulos.push(currentMod);

      // PDFs e videos
      Array.from(document.querySelectorAll('a[href]')).forEach(a => {
        const href = a.getAttribute('href') || '';
        if (/\.pdf(\?|$)/i.test(href)) out.pdfUrls.push(href);
        if (/\.(mp4|webm|m3u8)(\?|$)/i.test(href)) out.videoUrls.push(href);
      });
      Array.from(document.querySelectorAll('iframe[src], video source')).forEach(el => {
        const src = el.getAttribute('src') || '';
        if (src) out.videoUrls.push(src);
      });

      // Dedup
      out.pdfUrls = [...new Set(out.pdfUrls)];
      out.videoUrls = [...new Set(out.videoUrls)];

      return out;
    });

    const result = {
      ok: true,
      titulo: cursoData.titulo || targetCard.title,
      autor: targetCard.autor,
      url: urlAfter,
      urlBefore,
      descricao: cursoData.descricao,
      modulos: cursoData.modulos,
      pdfUrls: cursoData.pdfUrls,
      videoUrls: cursoData.videoUrls,
      rawTextLen: cursoData.rawText.length,
      rawCardSnapshot: targetCard,
      extractedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    };

    if (opts.includeRawText) result.rawText = cursoData.rawText;
    if (opts.includeRawHtml) result.rawHtml = await page.content();

    return result;
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Extrai N cursos sequencialmente. Reusa 1 browser/sessão pra todos.
 *
 * @param {object} opts
 * @param {string[]} opts.titleMatches  — array de substrings de títulos
 * @param {number[]} opts.clickIdxs     — alternativa: array de indexes do inventario
 * @param {string[]} opts.statusFilter  — default ['disponivel', 'em-andamento']
 * @param {boolean} opts.includeRawText — passa pra extrairCurso
 * @returns {object} { ok, cursos: [...], errors, durationMs }
 */
async function extrairLote(opts = {}) {
  const startedAt = Date.now();
  const statusFilter = opts.statusFilter || ['disponivel', 'em-andamento'];

  // Decide o que extrair: se titleMatches/clickIdxs explicito, usa direto.
  // Senão, roda inventario primeiro pra filtrar por status.
  let alvos = [];
  if (opts.titleMatches?.length) {
    alvos = opts.titleMatches.map(t => ({ titleMatch: t }));
  } else if (opts.clickIdxs?.length) {
    alvos = opts.clickIdxs.map(idx => ({ clickIdx: idx }));
  } else {
    const inv = await inventarioRaiz({ areas: ['/tracks'] });
    if (!inv.ok) return { ok: false, error: 'inventario falhou: ' + inv.error };
    const cards = inv.areas[0]?.cards || [];
    alvos = cards
      .filter(c => statusFilter.includes(c.status))
      .map(c => ({ clickIdx: c.clickIdx, titleMatch: c.title }));
  }

  const cursos = [];
  const errors = [];
  for (const alvo of alvos) {
    const r = await extrairCurso({ ...alvo, includeRawText: opts.includeRawText });
    if (r.ok) cursos.push(r);
    else errors.push({ alvo, error: r.error });
  }

  return {
    ok: errors.length === 0,
    cursos,
    errors,
    countAlvos: alvos.length,
    countCursos: cursos.length,
    countErrors: errors.length,
    durationMs: Date.now() - startedAt,
  };
}

module.exports = {
  extrairCurso,
  extrairLote,
};
