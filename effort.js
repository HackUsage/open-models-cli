'use strict';

// ponytail: kein "echtes" Thinking-Budget wie bei Claude (kein portables API dafuer bei
// beliebigen OpenAI-kompatiblen Endpunkten) -- Annaeherung ueber zwei Hebel: max_tokens
// (Antwortlaenge) + ein Nudge-Prompt ("sei kurz" vs. "denke gruendlich"). 'high' entspricht
// dem bisherigen festen Wert (8192), damit sich fuer bestehende Configs nichts aendert.
const EFFORT_LEVELS = {
  low: { label: 'Low (kurz, schnell)', maxTokens: 1024, prompt: 'Antworte kurz und direkt, ohne lange Herleitung.' },
  medium: { label: 'Medium', maxTokens: 4096, prompt: null },
  high: { label: 'High (Standard)', maxTokens: 8192, prompt: 'Denke Schritt fuer Schritt, pruefe Kantenfaelle, sei gruendlich.' },
  xhigh: {
    label: 'XHigh (sehr gruendlich)',
    maxTokens: 8192,
    prompt: 'Denke sehr gruendlich und mehrperspektivisch, hinterfrage deine erste Antwort und pruefe Annahmen explizit, bevor du antwortest.',
  },
};

function effortMaxTokens(effortKey) {
  return (EFFORT_LEVELS[effortKey] || EFFORT_LEVELS.high).maxTokens;
}

function effortSystemMessage(effortKey) {
  const level = EFFORT_LEVELS[effortKey];
  return level && level.prompt ? { role: 'system', content: level.prompt } : null;
}

module.exports = { EFFORT_LEVELS, effortMaxTokens, effortSystemMessage };
