'use strict';

const { spawn } = require('child_process');

// ponytail: nur stdio-Transport (Server als lokaler Kindprozess, JSON-RPC ueber
// Newline-getrennte stdin/stdout) -- deckt den Grossteil des MCP-Oekosystems ab. Kein
// SSE/HTTP-Transport, keine Resources/Prompts (nur Tools) -- reicht fuer "externe Tools
// anbinden", ist aber kein vollstaendiger MCP-Client.
const MCP_PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 15000;

class MCPClient {
  constructor(name, command, args) {
    this.name = name;
    this.tools = [];
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc.stdout.on('data', (d) => this._onData(d));
    this.proc.on('error', (err) => this._rejectAll(err));
    this.proc.on('exit', () => this._rejectAll(new Error(`MCP-Server "${name}" beendet.`)));
  }

  _rejectAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  _onData(chunk) {
    this.buffer += chunk.toString();
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // manche Server schreiben zusaetzliche Log-Zeilen auf stdout -- ignorieren
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'MCP-Fehler'));
        else resolve(msg.result);
      }
    }
  }

  _send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP "${this.name}": Zeitueberschreitung bei "${method}".`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
    });
  }

  _notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
  }

  async initialize() {
    await this._send('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'claude-nemotron-cli', version: '0.1.0' },
    });
    this._notify('notifications/initialized');
    const result = await this._send('tools/list');
    this.tools = result.tools || [];
    return this.tools;
  }

  async callTool(toolName, args) {
    const result = await this._send('tools/call', { name: toolName, arguments: args || {} });
    if (Array.isArray(result.content)) {
      return result.content.map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
    }
    return JSON.stringify(result);
  }

  close() {
    try {
      this.proc.kill();
    } catch {
      /* Prozess evtl. schon beendet */
    }
  }
}

// Wandelt MCP-Tool-Schemas in unser OpenAI-kompatibles tools-Format um, mit Server-Namen als
// Praefix (mcp__<server>__<tool>) -- verhindert Namenskollisionen zwischen Servern/eigenen Tools.
function mcpToolDefinitions(client) {
  return client.tools.map((t) => ({
    type: 'function',
    function: {
      name: `mcp__${client.name}__${t.name}`,
      description: `[MCP:${client.name}] ${t.description || t.name}`,
      parameters: t.inputSchema || { type: 'object', properties: {} },
    },
  }));
}

function isMcpTool(name) {
  return name.startsWith('mcp__');
}

function parseMcpTool(name) {
  const parts = name.split('__');
  return { serverName: parts[1], toolName: parts.slice(2).join('__') };
}

module.exports = { MCPClient, mcpToolDefinitions, isMcpTool, parseMcpTool };
