// services/scrape/taxlife/ — orquestrador.
// Reexporta funções dos módulos internos pra uso pelo server.js.

const client = require('./client');
const inventario = require('./inventario');
const extractor = require('./extractor');
const normalize = require('./normalize');

module.exports = {
  // Sessão
  authenticatedPage: client.authenticatedPage,
  healthcheck:       client.healthcheck,
  _cfg:              client._cfg,
  // Inventário
  inventarioRaiz:    inventario.inventarioRaiz,
  aprofundarHrefs:   inventario.aprofundarHrefs,
  // Extrator
  extrairCurso:      extractor.extrairCurso,
  extrairLote:       extractor.extrairLote,
  // Normalize (Fase 2)
  normalize:         normalize.run,
  normalizeCurso:    normalize.normalizeCurso,
};
