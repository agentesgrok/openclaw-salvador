const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const MEMORY_DIR = path.join(__dirname, '..', 'data', 'memory');

fs.ensureDirSync(MEMORY_DIR);

function _filePath(key) {
  return path.join(MEMORY_DIR, `${key}.json`);
}

function _sha256(content) {
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
}

// Lê uma entrada. Retorna { content, sha256 } ou null.
function read(key) {
  try {
    const data = fs.readJsonSync(_filePath(key));
    return { content: data.content, sha256: data.sha256 };
  } catch {
    return null;
  }
}

// Escreve com controle de concorrência (precondition).
// precondition=null → força escrita (primeira vez).
// precondition=sha256 → só grava se hash atual bater.
// Retorna { ok, sha256 } ou { ok: false, reason }
function write(key, content, precondition = null) {
  const existing = read(key);

  if (precondition !== null) {
    const currentHash = existing?.sha256 ?? null;
    if (currentHash !== precondition) {
      return { ok: false, reason: 'hash_mismatch', current: currentHash };
    }
  }

  const sha256 = _sha256(content);
  fs.writeJsonSync(_filePath(key), { key, content, sha256, updatedAt: Date.now() }, { spaces: 2 });
  return { ok: true, sha256 };
}

// Append seguro a uma lista (lê → modifica → escreve com precondition).
function append(key, item, maxItems = 200) {
  const existing = read(key);
  const list = existing?.content ?? [];
  const sha256 = existing?.sha256 ?? null;

  const updated = [...list, { ...item, at: Date.now() }].slice(-maxItems);
  return write(key, updated, sha256);
}

// Lista todas as chaves disponíveis.
function keys() {
  try {
    return fs.readdirSync(MEMORY_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch { return []; }
}

// Lê múltiplas chaves de uma vez.
function readMany(keyList) {
  const result = {};
  for (const k of keyList) {
    const entry = read(k);
    if (entry) result[k] = entry.content;
  }
  return result;
}

module.exports = { read, write, append, keys, readMany };
