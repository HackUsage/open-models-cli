'use strict';

const fs = require('fs');

// Sehr einfache Heuristik -- erkennt offensichtliche Versuche, das Modell per Tool-Ergebnis
// (Dateiinhalt, MCP-Antwort, etc.) umzusteuern. Kein Ersatz fuer echte Content-Security, nur
// ein sichtbarer Hinweis fuer den Nutzer, kein automatischer Block (das Modell entscheidet
// selbst, ob es dem Inhalt vertraut -- wir warnen nur).
const INJECTION_PATTERNS = [
  /ignore (all |the )?(previous|above) instructions/i,
  /disregard (all |the )?(previous|prior) instructions/i,
  /you are now (a|an) /i,
  /neue(n)? anweisung(en)?:/i,
  /ignoriere (alle |die )?(vorherigen|bisherigen) anweisungen/i,
];

function scanForInjection(text) {
  if (!text) return null;
  const hit = INJECTION_PATTERNS.find((re) => re.test(text));
  return hit ? hit.source : null;
}

// Best-effort: Schreibfehler beim Audit-Log duerfen den eigentlichen Tool-Aufruf nicht
// verhindern, deshalb kein throw.
function appendAuditLog(logPath, entry) {
  try {
    fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
  } catch {
    /* Audit-Log ist ein Komfortfeature, kein Fehlerfall wert */
  }
}

module.exports = { scanForInjection, appendAuditLog };
