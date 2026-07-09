'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG_PATH } = require('./providers');

// Selbstdiagnose: sammelt pro Modell-Preset, wie oft es Retries braucht, wie oft es am Ende
// trotzdem fehlschlaegt und wie lange es im Schnitt dauert. Ziel: Rollen, deren zugewiesenes
// Modell sich als unzuverlaessig/langsam erweist, automatisch auf ein anderes Modell
// umleiten, statt bei jedem Zug erneut lange Retry-Ketten zu produzieren. Persistiert nach
// jedem Aufruf (~/.claude-nemotron-cli/model-health.json) -- ohne das wuerde jeder Neustart
// wieder bei null anfangen und die ersten (langsamen) Lern-Aufrufe pro Modell wiederholen.
const MIN_SAMPLES = 2;
const UNHEALTHY_ERROR_RATE = 0.5;
const UNHEALTHY_RETRY_RATIO = 1.5;
const SLOW_MS_THRESHOLD = 45000;

const HEALTH_PATH = path.join(path.dirname(CONFIG_PATH), 'model-health.json');
// Alte Diagnosedaten (z.B. von einem laengst behobenen Anbieter-Ausfall vor Tagen) sollen
// ein Modell nicht auf ewig blockieren -- nach STALE_MS wird ein Eintrag beim Laden
// verworfen, das Modell bekommt beim naechsten Start wieder eine neutrale Chance.
const STALE_MS = 6 * 60 * 60 * 1000;

function loadStats() {
  try {
    const raw = JSON.parse(fs.readFileSync(HEALTH_PATH, 'utf-8'));
    const now = Date.now();
    const map = new Map();
    for (const [key, entry] of Object.entries(raw)) {
      if (entry && typeof entry.updatedAt === 'number' && now - entry.updatedAt < STALE_MS) {
        map.set(key, entry);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveStats() {
  try {
    fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
    fs.writeFileSync(HEALTH_PATH, JSON.stringify(Object.fromEntries(stats), null, 2), 'utf-8');
  } catch {
    /* Persistenz ist ein Komfortfeature, kein Fehlerfall wert */
  }
}

const stats = loadStats();

function getStats(modelKey) {
  if (!stats.has(modelKey)) stats.set(modelKey, { calls: 0, retries: 0, errors: 0, totalMs: 0, updatedAt: Date.now() });
  return stats.get(modelKey);
}

function recordAttempt(modelKey, { retries = 0, errored = false, durationMs = 0 } = {}) {
  const s = getStats(modelKey);
  s.calls += 1;
  s.retries += retries;
  s.errors += errored ? 1 : 0;
  s.totalMs += durationMs;
  s.updatedAt = Date.now();
  saveStats();
}

// Erst ab MIN_SAMPLES Aufrufen urteilen -- ein einzelner Ausreisser (z.B. ein transienter
// 503) soll nicht sofort zum Modell-Wechsel fuehren, ein wiederkehrendes Muster schon.
function diagnose(modelKey) {
  const s = stats.get(modelKey);
  if (!s || s.calls < MIN_SAMPLES) return { unhealthy: false, reason: null };
  const errorRate = s.errors / s.calls;
  const avgRetries = s.retries / s.calls;
  const avgMs = s.totalMs / s.calls;
  if (errorRate >= UNHEALTHY_ERROR_RATE) {
    return { unhealthy: true, reason: `${Math.round(errorRate * 100)}% der Aufrufe fehlgeschlagen` };
  }
  if (avgRetries >= UNHEALTHY_RETRY_RATIO) {
    return { unhealthy: true, reason: `im Schnitt ${avgRetries.toFixed(1)} Retries pro Aufruf` };
  }
  if (avgMs >= SLOW_MS_THRESHOLD) {
    return { unhealthy: true, reason: `im Schnitt ${Math.round(avgMs / 1000)}s Antwortzeit` };
  }
  return { unhealthy: false, reason: null };
}

// Hart codierte Ausweich-Modelle, falls noch kein anderer Kandidat in dieser Sitzung
// getestet und als gesund bekannt ist (z.B. gleich der allererste Zug schlaegt schon fehl).
const FALLBACK_POOL = ['nemotron-super', 'gpt-oss-120b', 'kimi-k2.6', 'nemotron-nano9b'];

function pickReplacement(currentModelKey, candidateKeys) {
  const healthyTracked = candidateKeys
    .filter((k) => k !== currentModelKey && stats.has(k) && !diagnose(k).unhealthy)
    .sort((a, b) => stats.get(a).totalMs / stats.get(a).calls - stats.get(b).totalMs / stats.get(b).calls);
  if (healthyTracked.length) return healthyTracked[0];
  const fallback = FALLBACK_POOL.find((k) => k !== currentModelKey);
  return fallback || currentModelKey;
}

module.exports = { recordAttempt, diagnose, pickReplacement };
