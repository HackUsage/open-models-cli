'use strict';

const fs = require('fs');
const path = require('path');

// Eigene Slash-Commands als Markdown-Dateien (deckt zugleich das "Skill"-Konzept ab: eine
// wiederverwendbare Anleitung, per Name aufrufbar -- ein zweites, redundantes System dafuer
// waere unnoetig). $ARGUMENTS wird durch den Rest der Eingabe ersetzt.
const COMMANDS_DIR = path.join(__dirname, 'commands');

function loadCustomCommand(name) {
  const file = path.join(COMMANDS_DIR, `${name}.md`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

function listCustomCommands() {
  if (!fs.existsSync(COMMANDS_DIR)) return [];
  return fs
    .readdirSync(COMMANDS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
}

function renderCommand(template, args) {
  return template.includes('$ARGUMENTS') ? template.split('$ARGUMENTS').join(args) : `${template}\n\n${args}`;
}

module.exports = { COMMANDS_DIR, loadCustomCommand, listCustomCommands, renderCommand };
