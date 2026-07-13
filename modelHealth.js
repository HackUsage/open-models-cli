'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG_PATH, MODEL_PRESETS } = require('./providers');
const { isQuotaMessage } = require('./errorClassify');
const { isExhausted } = require('./keyPool');

// Selbstdiagnose: sammelt pro Modell-Preset, wie oft es Retries braucht, wie oft es am Ende
// trotzdem fehlschlaegt und wie lange es im Schnitt dauert. Ziel: Rollen, deren zugewiesenes
// Modell sich als unzuverlaessig/langsam erweist, automatisch auf ein anderes Modell
// umleiten, statt bei jedem Zug erneut lange Retry-Ketten zu produzieren. Persistiert nach
// jedem Aufruf (~/.claude-nemotron-cli/model-health.json) -- ohne das wuerde jeder Neustart
// wieder bei null anfangen und die ersten (langsamen) Lern-Aufrufe pro Modell wiederholen.
const MIN_SAMPLES = 2;
const UNHEALTHY_ERROR_RATE = 0.5;
const UNHEALTHY_RETRY_RATIO = 1.5;
// Auf Nutzerwunsch: ein fixer Schwellwert ignoriert, dass ALLE Presets mal gleichzeitig
// langsam sein koennen (z.B. hohe Auslastung bei kostenlosen Anbietern zu Stosszeiten) --
// dann wuerde praktisch jedes Modell als "unhealthy" gelten, obwohl eines im Vergleich zu
// den anderen trotzdem klar das bessere ist. SLOW_MS_THRESHOLD bleibt die UNTERGRENZE (im
// Normalfall, wenn die meisten Modelle deutlich schneller sind, soll ein 45s+ Ausreisser
// weiterhin auffallen) -- effectiveSlowThreshold() hebt die Schwelle nur an, wenn der
// Fleet-Median selbst schon hoch liegt.
const SLOW_MS_THRESHOLD = 45000;
const SLOW_RELATIVE_MULTIPLIER = 2.5;

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
function recordAttempt(modelKey, { retries = 0, errored = false, durationMs = 0, errorMessage = '' } = {}) {
  reloadFromDisk(); // erst den aktuellen (evtl. von anderen Instanzen aktualisierten) Stand holen
  const s = getStats(modelKey);
  s.calls += 1;
  s.retries += retries;
  s.errors += errored ? 1 : 0;
  s.totalMs += durationMs;
  if (errored && isQuotaMessage(errorMessage)) s.permanent = true;
  s.updatedAt = Date.now();
  saveStats();
}

// Fleet-Median der Antwortzeit ueber alle aktuell getesteten (MIN_SAMPLES erreicht, nicht
// permanent gesperrten) Presets -- Grundlage fuer die RELATIVE Langsam-Schwelle. Ohne genug
// Vergleichsdaten (0-1 getestete Presets) bleibt es bei SLOW_MS_THRESHOLD als Fallback.
function effectiveSlowThreshold() {
  const avgTimes = [...stats.values()]
    .filter((s) => s.calls >= MIN_SAMPLES && !s.permanent)
    .map((s) => s.totalMs / s.calls)
    .sort((a, b) => a - b);
  if (!avgTimes.length) return SLOW_MS_THRESHOLD;
  const median = avgTimes[Math.floor(avgTimes.length / 2)];
  return Math.max(SLOW_MS_THRESHOLD, median * SLOW_RELATIVE_MULTIPLIER);
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
  const slowThreshold = effectiveSlowThreshold();
  if (avgMs >= slowThreshold) {
    return { unhealthy: true, reason: `im Schnitt ${Math.round(avgMs / 1000)}s Antwortzeit (>= ${Math.round(slowThreshold / 1000)}s Schwelle relativ zum Fleet-Median)` };
  }
  return { unhealthy: false, reason: null };
}

// ponytail: 2. Bug, den ein echter Langzeit-Lauf aufgedeckt hat -- der LETZTE Fallback-Zweig
// (wenn weder ein getrackt-gesundes Modell noch der hart codierte FALLBACK_POOL uebrig war)
// pickte bisher blind candidateKeys.find(k => k !== currentModelKey) -- ignoriert dabei
// KOMPLETT, ob dieses Modell selbst schon als unhealthy bekannt ist. Da Object.keys(MODEL_PRESETS)
// mit 'deepseek-v4' beginnt, landete in einem Lauf mit vielen gleichzeitig limitierten Modellen
// (mehrere Provider-Ausfaelle/Rate-Limits) am Ende IMMER 'deepseek-v4' -- selbst wenn genau DAS
// Modell Sekunden zuvor selbst als zu langsam/unhealthy diagnostiziert und ersetzt wurde. Fix:
// EIN einziger Kandidaten-Pool (alle candidateKeys statt eines separaten 4er-Hardcode-Pools) --
// zuerst bevorzugt getestet+gesund (schnellstes zuerst), sonst irgendein noch NIE getestetes
// (unbekannt ist besser als bekannt kaputt), und NUR wenn wirklich ALLES bekannt unhealthy ist,
// das mit der niedrigsten Fehlerquote -- nie mehr blinde Array-Reihenfolge.
// Keys sind pro PROVIDER eingetragen, nicht pro Preset (siehe keyPool.js) -- alle NIM-Presets
// (deepseek-v4/qwen-397b/kimi-k2.6/glm-5) teilen sich also denselben Key-Pool. Ein Modell-
// Wechsel innerhalb desselben limitierten Providers bringt nichts. hasLiveKey prueft, ob der
// Provider dieses Presets AKTUELL mindestens einen nicht-erschoepften Key hat -- ohne config
// (Rueckwaertskompatibel fuer Aufrufer, die noch keine config durchreichen) wird nichts gefiltert.
function hasLiveKey(presetKey, config) {
  if (!config) return true;
  const preset = MODEL_PRESETS[presetKey];
  if (!preset) return true;
  const keys = (config.keys && config.keys[preset.provider]) || [];
  const usableKeys = keys.filter((k) => k && k.trim());
  if (!usableKeys.length) return true; // kein Key eingetragen ist ein anderes Problem als "limitiert"
  return usableKeys.some((k) => !isExhausted(preset.provider, k));
}

function pickReplacement(currentModelKey, candidateKeys, config = null) {
  const isUsable = (k) => k !== currentModelKey && !diagnose(k).unhealthy;
  const usable = candidateKeys.filter(isUsable);
  if (usable.length) {
    // Kandidaten auf Providern MIT lebendigem Key bevorzugen -- nur wenn das die Auswahl nicht
    // komplett leerraeumt (dann lieber ein moeglicherweise noch limitierter Kandidat als gar
    // keiner, der naechste Request probiert es einfach erneut).
    const withLiveKey = usable.filter((k) => hasLiveKey(k, config));
    const pool = withLiveKey.length ? withLiveKey : usable;
    const tested = pool
      .filter((k) => stats.has(k))
      .sort((a, b) => stats.get(a).totalMs / stats.get(a).calls - stats.get(b).totalMs / stats.get(b).calls);
    return tested[0] || pool[0];
  }
  const others = candidateKeys.filter((k) => k !== currentModelKey);
  if (!others.length) return currentModelKey;
  reloadFromDisk();
  const withLiveKeyOthers = others.filter((k) => hasLiveKey(k, config));
  const scorePool = withLiveKeyOthers.length ? withLiveKeyOthers : others;

  // Ein Modell, das SCHNELL aber falsch/leer antwortet, ist NIE besser als eines, das
  // LANGSAM aber tatsaechlich korrekt antwortet -- echte Fehlerquote/Retry-Probleme muessen
  // daher IMMER vor reinen Latenz-Problemen gemieden werden. Bug, den ein echter Lauf
  // aufgedeckt hat: die alte kombinierte Score-Formel normierte Fehlerquote auf 0.5, Latenz
  // aber auf ein FIXES 45s -- bei einem insgesamt langsamen Fleet (100s+ ueberall) dominierte
  // der Latenz-Term jede Rechnung so stark, dass ein 100%-defektes, aber SCHNELL scheiterndes
  // Modell (274ms bis zur leeren Antwort) besser abschnitt als ein 0%-Fehler-Modell mit 130s
  // Antwortzeit -- der Coordinator landete dadurch garantiert immer wieder bei einem Modell,
  // das nichts liefert. Fix: erst NUR unter Kandidaten OHNE echtes Fehlerquote/Retry-Problem
  // nach der schnellsten suchen. Der volle kombinierte Score ist NUR noch der allerletzte
  // Ausweg, wenn WIRKLICH jeder verbleibende Kandidat ein echtes Fehlerproblem hat.
  const isErrorFree = (k) => {
    const s = stats.get(k);
    if (!s || !s.calls) return true; // ungetestet -- kein bekanntes Fehlerproblem
    if (s.permanent) return false;
    return (s.errors / s.calls) < UNHEALTHY_ERROR_RATE && (s.retries / s.calls) < UNHEALTHY_RETRY_RATIO;
  };
  const errorFreePool = scorePool.filter(isErrorFree);
  if (errorFreePool.length) {
    const tested = errorFreePool
      .filter((k) => stats.has(k))
      .sort((a, b) => stats.get(a).totalMs / stats.get(a).calls - stats.get(b).totalMs / stats.get(b).calls);
    return tested[0] || errorFreePool[0];
  }

  // Wirklich ALLES hat ein echtes Fehlerproblem -- kombinierter Score (Latenz relativ zur
  // Fleet-Schwelle normiert, nicht mehr fix 45s) als letzter Ausweg. permanent (Kontingent/
  // Tageslimit) wird weiterhin gemieden, so lange noch ein anderer Kandidat uebrig ist.
  const slowThreshold = effectiveSlowThreshold();
  const score = (s) => (s.errors / s.calls) / UNHEALTHY_ERROR_RATE
    + (s.retries / s.calls) / UNHEALTHY_RETRY_RATIO
    + (s.totalMs / s.calls) / slowThreshold;
  let best = scorePool[0];
  let bestScore = Infinity;
  for (const k of scorePool) {
    const s = stats.get(k);
    if (s?.permanent) continue;
    const candidateScore = s ? score(s) : 0; // ungetestet = neutral, nicht "unendlich schlecht"
    if (candidateScore < bestScore) {
      bestScore = candidateScore;
      best = k;
    }
  }
  return best;
}

// Diagnose-Uebersicht ueber ALLE Presets auf einmal -- Nutzerfrage "warum wechseln die Modelle
// nur zwischen 2 hin und her, es gibt doch fast 10?" laesst sich damit tatsaechlich beantworten
// statt geraten: entweder sind wirklich fast alle anderen aktuell (permanent) gesperrt, oder es
// steckt doch ein Bug in der Auswahl -- ohne diese Uebersicht war beides von aussen ununterscheidbar.
function listHealth(candidateKeys) {
  reloadFromDisk();
  return candidateKeys.map((k) => {
    const s = stats.get(k);
    return {
      key: k,
      calls: s ? s.calls : 0,
      errors: s ? s.errors : 0,
      avgMs: s && s.calls ? Math.round(s.totalMs / s.calls) : null,
      avgRetries: s && s.calls ? +(s.retries / s.calls).toFixed(1) : null,
      permanent: s ? !!s.permanent : false,
      ...diagnose(k),
    };
  });
}

// Manuelles Zuruecksetzen statt auf STALE_MS (6h) zu warten -- z.B. wenn der Nutzer sicher ist,
// dass ein Anbieter-Ausfall vorbei ist, oder einfach allen Presets wieder eine neutrale Chance
// geben will, ohne die laufende Sitzung/den Loop dafuer zu unterbrechen.
function resetHealth(modelKey = null) {
  reloadFromDisk();
  if (modelKey) stats.delete(modelKey);
  else stats.clear();
  saveStats();
}

module.exports = { recordAttempt, diagnose, pickReplacement, listHealth, resetHealth };
