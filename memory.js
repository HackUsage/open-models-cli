'use strict';

const fs = require('fs');
const path = require('path');

// Getrennt von NEMOTRON.md (das schreibt der NUTZER selbst, wird nur gelesen) -- diese Datei
// schreibt das TOOL SELBST nach jedem erfolgreichen Agent-Lauf. Zweck: ein Modellwechsel
// (/model x) im selben Fenster sieht danach sofort, was der letzte Swarm/Hive/Agent-Lauf
// gebaut hat, statt bei null anzufangen (bisher ging dieser Kontext beim Lauf-Ende verloren).
const PROJECT_MEMORY_FILENAME = 'AGENTS_MEMORY.md';
const MAX_MEMORY_CHARS = 20000;
const ENTRY_SEPARATOR = '\n---\n';

function memoryPath(root) {
  return path.join(root, PROJECT_MEMORY_FILENAME);
}

function loadProjectMemory(root) {
  try {
    return fs.readFileSync(memoryPath(root), 'utf-8');
  } catch {
    return null;
  }
}

// entry: { task: string, files: string[], summary: string }
function appendProjectMemory(root, entry) {
  const timestamp = new Date().toISOString();
  const filesLine = entry.files && entry.files.length ? entry.files.join(', ') : '(keine erkannten Datei-Aenderungen)';
  const block =
    `## ${timestamp}\n` +
    `**Aufgabe:** ${entry.task}\n` +
    `**Dateien:** ${filesLine}\n` +
    `**Ergebnis:** ${entry.summary}\n`;

  const existing = loadProjectMemory(root) || '';
  let combined = existing ? existing.trimEnd() + ENTRY_SEPARATOR + block : block;

  // Aelteste Eintraege zuerst droppen, wenn die Datei zu gross wird -- gleiches Prinzip wie
  // die Kontext-Kompaktierung in index.js (die neuesten Eintraege sind am relevantesten).
  if (combined.length > MAX_MEMORY_CHARS) {
    const parts = combined.split(ENTRY_SEPARATOR);
    while (parts.length > 1 && parts.join(ENTRY_SEPARATOR).length > MAX_MEMORY_CHARS) {
      parts.shift();
    }
    combined = parts.join(ENTRY_SEPARATOR);
  }

  try {
    fs.writeFileSync(memoryPath(root), combined, 'utf-8');
  } catch {
    /* Projekt-Gedaechtnis ist ein Komfortfeature, kein Fehlerfall wert */
  }
}

module.exports = { PROJECT_MEMORY_FILENAME, loadProjectMemory, appendProjectMemory };
