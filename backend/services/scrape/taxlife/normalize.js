// TaxLife normalize — converte cursos extraídos em .md prontos pro NotebookLM.
//
// V1: 1 .md por curso (não por módulo).
// Razão: extractor.js só captura título + rawText do main + lista de
// h2/h3/h4/h5 detectados. Não navega aula-por-aula (ainda). Granularidade
// por módulo exigiria clicks adicionais — escopo da V1.1.
//
// Output:
//   { path, title, content, hash, slug, frontmatterMeta }
// path: ~/.taxlife/cache/<slug-curso>.md
// hash: sha256(body) sem frontmatter (estável quando metadata muda)
// title: usado como NotebookLM source title

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.taxlife/cache');

function _slug(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'sem-titulo';
}

function _sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function _yamlEscape(v) {
  if (v == null) return '""';
  const s = String(v).replace(/"/g, '\\"').replace(/\n/g, ' ');
  return `"${s}"`;
}

function _renderFrontmatter(meta) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${_yamlEscape(item)}`);
    } else {
      lines.push(`${k}: ${_yamlEscape(v)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function _renderBody(curso) {
  const out = [];
  out.push(`# ${curso.titulo || 'Sem título'}`, '');
  if (curso.autor) out.push(`**Autor:** ${curso.autor}`, '');
  if (curso.descricao) out.push(curso.descricao.trim(), '');

  // Estrutura módulos/aulas (titles only — extractor V1 não captura body por aula)
  const mods = (curso.modulos || []).filter(m => (m.aulas || []).length > 0 || (m.titulo || '').length > 3);
  if (mods.length) {
    out.push('## Estrutura', '');
    for (const m of mods) {
      out.push(`### ${m.titulo}`);
      for (const a of (m.aulas || [])) {
        out.push(`- ${a.titulo}`);
      }
      out.push('');
    }
  }

  // rawText do main (conteúdo principal da página do curso)
  if (curso.rawText && curso.rawText.trim()) {
    out.push('## Conteúdo', '');
    out.push(curso.rawText.trim());
    out.push('');
  }

  // PDFs/videos como metadata textual (NotebookLM não baixa por nós)
  if ((curso.pdfUrls || []).length || (curso.videoUrls || []).length) {
    out.push('## Recursos referenciados', '');
    for (const u of (curso.pdfUrls || [])) out.push(`- PDF: ${u}`);
    for (const u of (curso.videoUrls || [])) out.push(`- Vídeo: ${u}`);
    out.push('');
  }

  return out.join('\n');
}

/**
 * Constrói payload estável pra hash — só campos canônicos do curso,
 * NÃO o rawText (que varia entre runs por hidratação SPA inconsistente).
 * Isso garante idempotência: se a estrutura do curso não mudou, hash bate.
 */
function _stableHashPayload(curso) {
  const mods = (curso.modulos || []).map(m => ({
    titulo: (m.titulo || '').trim(),
    aulas: (m.aulas || []).map(a => (a.titulo || '').trim()),
  }));
  return JSON.stringify({
    titulo: (curso.titulo || '').trim(),
    autor: (curso.autor || '').trim(),
    descricao: (curso.descricao || '').trim(),
    modulos: mods,
    pdfs: [...(curso.pdfUrls || [])].sort(),
    videos: [...(curso.videoUrls || [])].sort(),
  });
}

/**
 * Normaliza 1 curso extraído em arquivo .md + metadata.
 * Não escreve no disco — caller chama writeNormalized.
 */
function normalizeCurso(curso) {
  if (!curso || !curso.ok) {
    return { ok: false, error: 'curso inválido ou extração falhou' };
  }
  const slug = _slug(curso.titulo);
  const body = _renderBody(curso);
  const hash = _sha256(_stableHashPayload(curso));

  const fm = {
    curso: curso.titulo || '',
    slug,
    autor: curso.autor || '',
    url: curso.url || '',
    descricao: (curso.descricao || '').slice(0, 280),
    modulos_count: (curso.modulos || []).length,
    aulas_count: (curso.modulos || []).reduce((s, m) => s + (m.aulas?.length || 0), 0),
    pdfs_count: (curso.pdfUrls || []).length,
    videos_count: (curso.videoUrls || []).length,
    hash_sha256: hash,
    extracted_at: curso.extractedAt || new Date().toISOString(),
    fontes_originais: [curso.url].filter(Boolean),
  };

  const content = _renderFrontmatter(fm) + body;
  return {
    ok: true,
    slug,
    title: curso.titulo || slug,
    hash,
    body,
    content,
    frontmatterMeta: fm,
  };
}

/**
 * Salva o .md normalizado em cacheDir/<slug>--<hash8>.md.
 *
 * O hash vai NO FILENAME porque NotebookLM usa o nome do arquivo como
 * source title (`--title` é ignorado pra file sources). Isso permite
 * detectar idempotência via listSources sem ler conteúdo.
 *
 * Limpa versões antigas do mesmo slug (`<slug>--*.md`) antes de gravar.
 */
async function writeNormalized(normalized, cacheDir = DEFAULT_CACHE_DIR) {
  if (!normalized.ok) return normalized;
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const fileName = `${normalized.slug}--${normalized.hash.slice(0, 8)}.md`;
  const filePath = path.join(cacheDir, fileName);

  // Cleanup de hashes antigos do mesmo slug
  try {
    const entries = await fs.readdir(cacheDir);
    const stalePrefix = `${normalized.slug}--`;
    for (const e of entries) {
      if (e.startsWith(stalePrefix) && e.endsWith('.md') && e !== fileName) {
        await fs.unlink(path.join(cacheDir, e)).catch(() => {});
      }
    }
  } catch {}

  await fs.writeFile(filePath, normalized.content, { mode: 0o600 });
  return { ...normalized, path: filePath, fileName, written: true };
}

/**
 * Pipeline conveniente: normaliza array de cursos e escreve no cache.
 * Retorna { ok, items: [{slug, path, hash, title, ok}], errors, durationMs }.
 */
async function run(cursos, opts = {}) {
  const startedAt = Date.now();
  const cacheDir = opts.cacheDir || DEFAULT_CACHE_DIR;
  const items = [];
  const errors = [];
  for (const c of (cursos || [])) {
    try {
      const norm = normalizeCurso(c);
      if (!norm.ok) {
        errors.push({ titulo: c?.titulo, error: norm.error });
        continue;
      }
      const written = opts.dryRun ? norm : await writeNormalized(norm, cacheDir);
      items.push({
        slug: written.slug,
        title: written.title,
        path: written.path || null,
        fileName: written.fileName || `${written.slug}--${written.hash.slice(0,8)}.md`,
        hash: written.hash,
        bodyLen: written.body.length,
        modulos: written.frontmatterMeta.modulos_count,
        aulas: written.frontmatterMeta.aulas_count,
      });
    } catch (err) {
      errors.push({ titulo: c?.titulo, error: err.message });
    }
  }
  return {
    ok: errors.length === 0,
    items,
    errors,
    cacheDir,
    durationMs: Date.now() - startedAt,
  };
}

module.exports = {
  normalizeCurso,
  writeNormalized,
  run,
  _slug,
  _sha256,
  DEFAULT_CACHE_DIR,
};
