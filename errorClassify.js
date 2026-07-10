'use strict';

// Eigenes Mini-Modul statt in providers.js/modelHealth.js dupliziert -- modelHealth.js UND
// das neue keyPool.js brauchen dieselbe Erkennung "ist das ein Kontingent-/Rate-Limit-Fehler",
// aber providers.js darf nicht von keyPool.js importiert werden (keyPool wird VON providers.js
// importiert -- ein Ruecklauf waere ein zirkulaerer Require). Ein abhaengigkeitsfreies Modul
// loest das sauber fuer beide Seiten.
const QUOTA_PATTERN = /rate limit|quota|per-day|per-month|resource ?exhausted/i;

function isQuotaMessage(message) {
  return QUOTA_PATTERN.test(message || '');
}

module.exports = { QUOTA_PATTERN, isQuotaMessage };
