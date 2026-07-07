'use strict';

const { exec } = require('child_process');
const path = require('path');
const { resolveSafe } = require('./tools');

// ponytail: KEIN echter persistenter Shell-Prozess (Sentinel-Marker ueber Piped-Stdin,
// Shell-Echo-Eigenheiten je Plattform) -- stattdessen: jeder Befehl laeuft in einem frischen
// child_process.exec, aber cwd wird selbst getrackt und bei jedem Aufruf mitgegeben. Deckt den
// praktisch wichtigsten Fall ab (einmal "cd projekt", danach bleibt man dort). Echte
// Env-Var-Persistenz (z.B. "set X=Y" wirkt auf spaetere Aufrufe) geht damit NICHT -- jeder
// Prozess ist isoliert, das ist eine bewusste Grenze, kein Bug.
let currentCwd = null;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const MAX_OUTPUT_CHARS = 20000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

const backgroundJobs = new Map();
let nextJobId = 1;

// Nur zur zusaetzlichen Warnung, kein Blocker -- die normale Bestaetigung (y/N) gilt fuer
// JEDEN run_command-Aufruf, das hier haengt nur eine lautere Warnzeile davor.
const DANGEROUS_PATTERNS = [
  { re: /\bgit\s+push\b[^\n]*(--force|-f\b)/i, label: 'git push --force' },
  { re: /\bgit\s+reset\b[^\n]*--hard/i, label: 'git reset --hard' },
  { re: /\bgit\s+clean\b[^\n]*-f/i, label: 'git clean -f' },
  { re: /\brm\s+-rf\b/i, label: 'rm -rf' },
  { re: /\bdel\s+\/s\b/i, label: 'del /s' },
  { re: /\brd\s+\/s\b/i, label: 'rd /s' },
  { re: /\bformat\s+[a-z]:/i, label: 'format <laufwerk>' },
  { re: /\bdrop\s+(table|database)\b/i, label: 'DROP TABLE/DATABASE' },
];

function checkDangerous(command) {
  const hit = DANGEROUS_PATTERNS.find((p) => p.re.test(command));
  return hit ? hit.label : null;
}

function truncate(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n... (Ausgabe gekuerzt, ${text.length - MAX_OUTPUT_CHARS} weitere Zeichen)`;
}

function ensureCwd(root) {
  if (!currentCwd) currentCwd = path.resolve(root);
  return currentCwd;
}

function tryHandleCd(root, command) {
  const trimmed = command.trim();
  if (!/^cd(\s|$)/i.test(trimmed)) return null;
  // Nur REINE "cd <pfad>"-Befehle abfangen. Ein zusammengesetzter Befehl wie
  // "cd dir && node script.js" soll ganz normal per echtem Shell-exec laufen (der cd-Teil
  // gilt dann nur fuer DIESEN einen Aufruf) -- sonst wuerde hier faelschlich nur ein cd
  // simuliert (der GESAMTE Rest inkl. "&& node ...") wird als Pfad interpretiert), der Rest
  // des Befehls (das eigentliche Kommando) wird NIE ausgefuehrt, obwohl "OK" gemeldet wird.
  if (/&&|\|\||[;|\n]/.test(trimmed)) return null;
  const target = trimmed.replace(/^cd\s*/i, '').trim().replace(/^["']|["']$/g, '');
  const rootResolved = path.resolve(root);
  const cwd = ensureCwd(root);
  if (!target || target === '.') {
    return `Aktuelles Arbeitsverzeichnis: ${path.relative(rootResolved, cwd) || '.'}`;
  }
  const absTarget = path.resolve(cwd, target);
  const resolved = resolveSafe(root, path.relative(rootResolved, absTarget));
  currentCwd = resolved;
  return `OK: Arbeitsverzeichnis ist jetzt ${path.relative(rootResolved, currentCwd) || '.'}`;
}

function execOnce(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        timedOut: !!(err && err.killed && err.signal),
        errorMessage: err ? err.message : null,
      });
    });
  });
}

function formatResult(r) {
  let out = '';
  if (r.timedOut) out += `[Timeout erreicht -- Prozess abgebrochen]\n`;
  if (r.stdout) out += r.stdout;
  if (r.stderr) out += (out ? '\n' : '') + `[stderr]\n${r.stderr}`;
  out += `\n[exit code ${r.exitCode}]`;
  return truncate(out.trim());
}

async function runCommand(root, { command, timeout_ms, run_in_background }) {
  if (!command || !command.trim()) throw new Error('command darf nicht leer sein.');

  const cdResult = tryHandleCd(root, command);
  if (cdResult !== null) return cdResult;

  const timeoutMs = Math.min(Math.max(Number(timeout_ms) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
  const cwd = ensureCwd(root);

  if (run_in_background) {
    const id = String(nextJobId++);
    backgroundJobs.set(id, { done: false, result: null });
    execOnce(command, cwd, timeoutMs).then((r) => {
      backgroundJobs.set(id, { done: true, result: formatResult(r) });
    });
    return `Im Hintergrund gestartet (ID ${id}). Ergebnis abfragen mit read_background_output(id="${id}").`;
  }

  const r = await execOnce(command, cwd, timeoutMs);
  return formatResult(r);
}

function readBackgroundOutput(id) {
  const job = backgroundJobs.get(String(id));
  if (!job) throw new Error(`Keine Hintergrund-Aufgabe mit ID "${id}" gefunden.`);
  if (!job.done) return `Laeuft noch (ID ${id}).`;
  backgroundJobs.delete(String(id));
  return job.result;
}

function buildShellToolDefinitions(root) {
  return [
    {
      type: 'function',
      function: {
        name: 'run_command',
        description:
          `Fuehrt ein Shell-Kommando aus, Arbeitsverzeichnis-Start ist ${root}. "cd <pfad>" aendert das Arbeitsverzeichnis dauerhaft fuer folgende Aufrufe (bleibt sandboxed). ` +
          'Umgebungsvariablen bleiben NICHT zwischen Aufrufen erhalten (jeder Befehl laeuft in einem frischen Prozess). Der Nutzer muss jeden Aufruf bestaetigen.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Auszufuehrendes Shell-Kommando' },
            timeout_ms: { type: 'number', description: `Timeout in ms (Standard ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})` },
            run_in_background: { type: 'boolean', description: 'Sofort mit einer ID zurueckkehren statt auf Fertigstellung zu warten' },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_background_output',
        description: 'Fragt das Ergebnis eines mit run_command(run_in_background=true) gestarteten Kommandos ab.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Die von run_command zurueckgegebene ID' } },
          required: ['id'],
        },
      },
    },
  ];
}

const SHELL_WRITE_TOOLS = new Set(['run_command']);

module.exports = { buildShellToolDefinitions, runCommand, readBackgroundOutput, checkDangerous, SHELL_WRITE_TOOLS };
