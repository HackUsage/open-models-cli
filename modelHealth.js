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

const stats = new Map();

// Mehrere CLI-Instanzen koennen gleichzeitig laufen (eigene Prozesse, kein gemeinsamer
// Speicher) -- ohne das hier wuerde jede Instanz beim Speichern blind ihren EIGENEN,
// moeglicherweise veralteten Stand ueberschreiben und damit alles verwerfen, was eine
// ANDERE Instanz inzwischen gelernt hat (z.B. "Modell X ist gerade limitiert"). Deshalb:
// vor jedem Lesen UND vor jedem Schreiben frisch von der Platte einlesen, statt sich auf
// einen einmal beim Start geladenen In-Memory-Stand zu verlassen -- macht die Selbstdiagnose
// instanzuebergreifend konsistent (kein Lock noetig, die Datei ist klein, ein Re-Read kostet
// Mikrosekunden gegenueber Modell-Aufrufen, die Sekunden bis Minuten dauern).
function reloadFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(HEALTH_PATH, 'utf-8'));
    const now = Date.now();
    stats.clear();
    for (const [key, entry] of Object.entries(raw)) {
      if (entry && typeof entry.updatedAt === 'number' && now - entry.updatedAt < STALE_MS) {
        stats.set(key, entry);
      }
    }
  } catch {
    /* Datei fehlt/kaputt -- mit dem bisherigen In-Memory-Stand weitermachen */
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

function getStats(modelKey) {
  if (!stats.has(modelKey)) stats.set(modelKey, { calls: 0, retries: 0, errors: 0, totalMs: 0, permanent: false, updatedAt: Date.now() });
  return stats.get(modelKey);
}

// Manche Fehler sind kein "voruebergehendes Ausreisser-Muster", sondern ein hartes,
// deterministisches Limit (z.B. OpenRouters taegliches Freikontingent pro Modell) --
// ein Retry oder ein zweiter Versuch aendert daran nichts. Solche Modelle SOFORT als
// unhealthy markieren (nicht erst nach MIN_SAMPLES), sonst verschwendet jeder weitere
// Loop-Durchlauf erneut einen kompletten Versuch auf ein bekannt totes Modell.
const PERMANENT_ERROR_PATTERN = /rate limit|quota|per-day|per-month|resource ?exhausted/i;

function isPermanentError(message) {
  return PERMANENT_ERROR_PATTERN.test(message || '');
}

function recordAttempt(modelKey, { retries = 0, errored = false, durationMs = 0, errorMessage = '' } = {}) {
  reloadFromDisk(); // erst den aktuellen (evtl. von anderen Instanzen aktualisierten) Stand holen
  const s = getStats(modelKey);
  s.calls += 1;
  s.retries += retries;
  s.errors += errored ? 1 : 0;
  s.totalMs += durationMs;
  if (errored && isPermanentError(errorMessage)) s.permanent = true;
  s.updatedAt = Date.now();
  saveStats();
}

// Erst ab MIN_SAMPLES Aufrufen urteilen -- ein einzelner Ausreisser (z.B. ein transienter
// 503) soll nicht sofort zum Modell-Wechsel fuehren, ein wiederkehrendes Muster schon.
// Ausnahme: s.permanent (siehe isPermanentError) gilt sofort, unabhaengig von MIN_SAMPLES.
// Liest ebenfalls frisch von der Platte -- eine Entscheidung soll den neuesten Stand sehen,
// auch wenn eine ANDERE Instanz seit dem letzten eigenen Aufruf etwas dazugelernt hat.
function diagnose(modelKey) {
  reloadFromDisk();
  const s = stats.get(modelKey);
  if (!s) return { unhealthy: false, reason: null };
  if (s.permanent) {
    return { unhealthy: true, reason: 'Anbieter-Limit erreicht (z.B. Tageskontingent) -- vermutlich erst nach einiger Zeit wieder nutzbar' };
  }
  if (s.calls < MIN_SAMPLES) return { unhealthy: false, reason: null };
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

// ponytail: Bug, den ein echter Langzeit-Lauf aufgedeckt hat -- der Fallback-Zweig schloss
// nur currentModelKey aus, NICHT bereits bekannte unhealthy Kandidaten. Ein Modell, das
// gerade erst als Ersatz diagnostiziert unhealthy wurde (z.B. Tageskontingent erschoepft),
// wurde dadurch als "Fallback" trotzdem IMMER WIEDER gewaehlt -- Endlos-Pingpong zwischen
// genau zwei kaputten Modellen statt Durchprobieren aller verfuegbaren Presets. Fix: sowohl
// der getrackte Pfad als auch der Fallback-Pool schliessen JEDES bekannt unhealthy Modell
// aus, nicht nur das urspruengliche. Bleibt am Ende nichts Gesundes uebrig (z.B. weil wirklich
// alle Presets gerade limitiert sind), lieber IRGENDEIN anderes Modell probieren als stur
// beim bekannt kaputten currentModelKey zu bleiben.
function pickReplacement(currentModelKey, candidateKeys) {
  const isUsable = (k) => k !== currentModelKey && !diagnose(k).unhealthy;
  const healthyTracked = candidateKeys
    .filter((k) => isUsable(k) && stats.has(k))
    .sort((a, b) => stats.get(a).totalMs / stats.get(a).calls - stats.get(b).totalMs / stats.get(b).calls);
  if (healthyTracked.length) return healthyTracked[0];
  const fallback = FALLBACK_POOL.find(isUsable);
  if (fallback) return fallback;
  const anyOther = candidateKeys.find((k) => k !== currentModelKey);
  return anyOther || currentModelKey;
}

module.exports = { recordAttempt, diagnose, pickReplacement };
