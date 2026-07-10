'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { isQuotaMessage } = require('./errorClassify');

// Mehrere API-Keys pro Anbieter (z.B. mehrere kostenlose Accounts fuer parallele Projekte) --
// wenn einer sein Limit erreicht (429/Kontingent), automatisch auf den naechsten wechseln statt
// den Nutzer selbst umschalten zu lassen. Gleiches Cross-Instance-Muster wie modelHealth.js:
// mehrere CLI-Instanzen teilen sich denselben Key-Pool (config.json liegt eh schon gemeinsam
// unter ~/.claude-nemotron-cli/), also vor jedem Lesen/Schreiben frisch von der Platte holen.
// Eigener Pfad statt CONFIG_PATH aus providers.js importiert -- providers.js importiert DIESES
// Modul, ein Ruecklauf waere ein zirkulaerer Require.
const STATE_PATH = path.join(os.homedir(), '.claude-nemotron-cli', 'key-health.json');
const SHORT_COOLDOWN_MS = 5 * 60 * 1000; // einfaches 429 (kurzfristiges Rate-Limit)
const LONG_COOLDOWN_MS = 12 * 60 * 60 * 1000; // Kontingent-/Tageslimit-Meldung

const state = new Map();

function reloadFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    state.clear();
    for (const [k, v] of Object.entries(raw)) state.set(k, v);
  } catch {
    /* Datei fehlt/kaputt -- mit bisherigem In-Memory-Stand weitermachen */
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(Object.fromEntries(state), null, 2), 'utf-8');
  } catch {
    /* Persistenz ist Komfortfeature, kein Fehlerfall wert */
  }
}

// Key nie im Klartext in dieser Datei -- nur ein Hash als Identifier (config.json enthaelt
// den Klartext ohnehin schon, keinen zweiten Ort dafuer schaffen).
function keyId(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function isExhausted(provider, key) {
  reloadFromDisk();
  const entry = state.get(`${provider}:${keyId(key)}`);
  return !!(entry && entry.exhaustedUntil > Date.now());
}

function reportKeyFailure(provider, key, errorMessage) {
  reloadFromDisk();
  const cooldownMs = isQuotaMessage(errorMessage) ? LONG_COOLDOWN_MS : SHORT_COOLDOWN_MS;
  state.set(`${provider}:${keyId(key)}`, { exhaustedUntil: Date.now() + cooldownMs, updatedAt: Date.now() });
  saveState();
}

// Ersten NICHT limitierten Key in Eintragsreihenfolge nehmen -- kein Round-Robin noetig,
// "naechster wenn einer limitiert ist" deckt den Use-Case. Sind alle limitiert, den mit dem
// kuerzesten verbleibenden Cooldown zurueckgeben (eher ein Versuch mit baldiger Erfolgschance
// als komplett zu verweigern).
function getActiveKey(provider, keys) {
  const usable = (keys || []).filter((k) => k && k.trim());
  if (!usable.length) return '';
  reloadFromDisk();
  for (const key of usable) {
    if (!isExhausted(provider, key)) return key;
  }
  return usable.reduce((soonest, key) => {
    const a = state.get(`${provider}:${keyId(soonest)}`)?.exhaustedUntil || 0;
    const b = state.get(`${provider}:${keyId(key)}`)?.exhaustedUntil || 0;
    return b < a ? key : soonest;
  });
}

module.exports = { getActiveKey, reportKeyFailure, isExhausted };
