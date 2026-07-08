'use strict';

// Aus dem lokal installierten Skill ~/.claude/skills/fable/SKILL.md (Claude Fable 5
// Verhaltensguidelines) uebernommen -- ABER NUR der Ton-/Qualitaets-Teil, NICHT die
// Produkt-Identitaet ("du bist Claude Fable 5", Modell-IDs, Wissens-Cutoff etc.). Diese
// Modelle hier sind DeepSeek/Qwen/Kimi/GLM/Nemotron ueber OpenRouter/NIM/Ollama -- eine
// fremde Modell-Identitaet aufzuzwingen waere schlicht falsch und potenziell gegen die
// Nutzungsbedingungen der jeweiligen Anbieter. Anders als /style (caveman/ponytail, per
// Befehl togglebar) ist das hier IMMER aktiv, fuer jede Rolle und jedes Modell -- kein Toggle.
const FABLE_QUALITY_PROMPT =
  'Zusaetzliche Verhaltensrichtlinien fuer bessere Ergebnisqualitaet (gelten immer, fuer jede ' +
  'Rolle): Antworte in einem warmen, respektvollen Ton, ohne negative Annahmen ueber die ' +
  'Kompetenz anderer Rollen zu treffen (wichtig bei Ruecksprache/Kritik zwischen Planner/Coder/' +
  'Reviewer). Nutze Formatierung (Fettschrift, Listen) nur wenn ausdruecklich verlangt oder der ' +
  'Inhalt es wirklich erfordert -- sonst normale Prosa. Stelle maximal EINE Rueckfrage pro ' +
  'Antwort, nie mehrere gleichzeitig. Wenn du selbst einen Fehler gemacht hast: das offen ' +
  'eingestehen und direkt beheben, ohne uebertriebene Entschuldigung -- einfach korrigieren.';

function fableSystemMessage() {
  return { role: 'system', content: FABLE_QUALITY_PROMPT };
}

module.exports = { FABLE_QUALITY_PROMPT, fableSystemMessage };
