#!/usr/bin/env node
'use strict';

/**
 * Brain MCP über stdio — für lokale Desktop-Clients (z.B. Claude Desktop).
 * Öffnet dieselbe brain.db (WAL → mehrere Prozesse sicher).
 *
 * WICHTIG: stdout ist der Protokollkanal — niemals dorthin loggen (nur stderr).
 *
 * Claude-Desktop-Config (Beispiel):
 *   "brain": { "command": "node", "args": ["/home/philipp/pq_brain/mcp/stdio.js"] }
 */

const { buildServer } = require('./tools');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

(async () => {
  // Separater Prozess → kein Broadcast an die WS-Clients des HTTP-Servers.
  const server = buildServer({ onWrite: () => {} });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Brain MCP (stdio) bereit\n');
})().catch(err => {
  process.stderr.write('MCP stdio Fehler: ' + err.message + '\n');
  process.exit(1);
});
