'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Ruflo-Vorbild (observability-engineer): strukturierte, korrelierbare Trace-Eintraege pro
// Swarm/Hive-Lauf statt nur fluechtiger Konsolen-Prints. Grund: der pickReplacement-Bug (ein
// Modell wurde durch ein Sekunden zuvor SELBST als unhealthy diagnostiziertes ersetzt) war aus
// dem Konsolen-Scrollback allein kaum nachvollziehbar -- mit `/trace <id>` liesse sich sowas
// direkt als zusammenhaengende Ereigniskette nachschlagen. JSONL statt JSON: jede Zeile ein
// unabhaengiges Ereignis, kein Parsen der Gesamtdatei zum Anhaengen noetig.
const TRACE_PATH = path.join(os.homedir(), '.claude-nemotron-cli', 'trace.jsonl');
const MAX_TRACE_BYTES = 2 * 1024 * 1024;

function newRunId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function rotateIfNeeded() {
  try {
    if (fs.statSync(TRACE_PATH).size <= MAX_TRACE_BYTES) return;
    // Aelteste Haelfte droppen statt die ganze Datei zu leeren -- juengste Traces bleiben da.
    const lines = fs.readFileSync(TRACE_PATH, 'utf-8').split('\n').filter(Boolean);
    fs.writeFileSync(TRACE_PATH, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n', 'utf-8');
  } catch {
    /* Rotation ist ein Komfortfeature, kein Fehlerfall wert */
  }
}

function logEvent(runId, event, detail = {}) {
  try {
    fs.mkdirSync(path.dirname(TRACE_PATH), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), run: runId || null, event, ...detail }) + '\n';
    fs.appendFileSync(TRACE_PATH, line, 'utf-8');
    rotateIfNeeded();
  } catch {
    /* Tracing ist ein Debug-Komfortfeature, darf einen echten Lauf nie zum Absturz bringen */
  }
}

function readTrace({ run = null, limit = 50 } = {}) {
  try {
    const lines = fs.readFileSync(TRACE_PATH, 'utf-8').split('\n').filter(Boolean);
    const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const filtered = run ? parsed.filter((e) => e.run === run) : parsed;
    return filtered.slice(-limit);
  } catch {
    return [];
  }
}

module.exports = { newRunId, logEvent, readTrace, TRACE_PATH };
