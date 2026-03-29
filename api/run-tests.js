// api/run-tests.js
// HTTP wrapper for the session flow test.
// Run with: node api/run-tests.js
// Then call: curl http://localhost:3001/run-tests
//
// Can be deployed as a Vercel serverless function by moving this file to
// the toody-api Vercel project under /api/run-tests.js and removing the
// http.createServer block at the bottom.
//
// ESM module (api/package.json sets "type": "module").

import http from 'http';
import { testSessionFlow } from './test-session-flow.js';

const PORT = process.env.PORT || 3001;

// Vercel / serverless handler (export for when deployed as a function)
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  if (url.pathname !== '/run-tests' && url.pathname !== '/') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Use GET /run-tests' }));
    return;
  }

  res.writeHead(200, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
  });

  try {
    const results = await testSessionFlow();
    res.end(JSON.stringify(results, null, 2));
  } catch (err) {
    res.end(JSON.stringify({ error: err.message, overallPass: false }));
  }
}

// Local server — only starts when run directly
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  const server = http.createServer(handler);
  server.listen(PORT, () => {
    console.log(`\nToody test server running at http://localhost:${PORT}/run-tests`);
    console.log('Press Ctrl+C to stop.\n');
  });
}
