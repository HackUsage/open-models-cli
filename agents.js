'use strict';

const fs = require('fs');
const path = require('path');

// "Plugin-Ordner": jede Agent-Rolle ist eine eigene JSON-Datei hier drin. Kein
// Marketplace/Registry -- fuer ein Ein-Personen-Tool reicht die eigene Sammlung.
const AGENTS_DIR = path.join(__dirname, 'agents');

function loadAgentRoles() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs
    .readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'pipeline.json')
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8'));
      } catch {
        return null;
      }
    })
    .filter((role) => role && role.name && role.systemPrompt && role.model);
}

function loadPipelineOrder(defaultOrder) {
  const pipelinePath = path.join(AGENTS_DIR, 'pipeline.json');
  if (!fs.existsSync(pipelinePath)) return defaultOrder;
  try {
    const parsed = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
    return Array.isArray(parsed.order) && parsed.order.length ? parsed.order : defaultOrder;
  } catch {
    return defaultOrder;
  }
}

module.exports = { AGENTS_DIR, loadAgentRoles, loadPipelineOrder };
