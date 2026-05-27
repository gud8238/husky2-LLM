/**
 * HuskyVision Unified WebRTC Stream Broker & MCP Proxy Server
 * 
 * 1. Automatically downloads and manages the go2rtc server lifecycle for ultra-low latency WebRTC streaming.
 * 2. Bridges frontend command requests to the HuskyLens 2 internal MCP SSE (Server-Sent Events) Server
 *    running on port 3000, translating requests to JSON-RPC tools/call protocol.
 */

import { spawn } from 'child_process';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';

const PORT = 9999;
const GO2RTC_PORT = 1984;
const GO2RTC_BINARY_URL = 'https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_win64.zip';

// Prepare bin directory for go2rtc
const binDir = path.join(process.cwd(), 'bin');
const go2rtcZipPath = path.join(binDir, 'go2rtc_win64.zip');

console.log('🚀 Starting Advanced HuskyVision WebRTC Broker & MCP Command Proxy...');
if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}
const go2rtcPath = path.join(binDir, 'go2rtc.exe');
let go2rtcProcess = null;

// Download helper for redirecting https URLs
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const request = https.get(url, (response) => {
      // Handle HTTP redirects (301, 302, 307, 308)
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        try { fs.unlinkSync(destPath); } catch (e) {}
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(destPath); } catch (e) {}
        return reject(new Error(`Failed to download binary: HTTP ${response.statusCode}`));
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    });

    request.on('error', (err) => {
      file.close();
      try { fs.unlinkSync(destPath); } catch (e) {}
      reject(err);
    });
  });
}

// Function to download and boot go2rtc
async function ensureGo2rtc() {
  if (fs.existsSync(go2rtcPath)) {
    console.log(`✅ go2rtc.exe is already present at ${go2rtcPath}`);
    startGo2rtc();
    return;
  }

  console.log(`⏳ Downloading go2rtc zip archive from ${GO2RTC_BINARY_URL}...`);
  try {
    await downloadFile(GO2RTC_BINARY_URL, go2rtcZipPath);
    console.log('🎉 Download complete. Unzipping go2rtc_win64.zip via PowerShell...');

    // Run powershell Expand-Archive command
    const unzipCmd = `Expand-Archive -Path "${go2rtcZipPath}" -DestinationPath "${binDir}" -Force`;
    await new Promise((resolve, reject) => {
      const ps = spawn('powershell', ['-Command', unzipCmd]);
      ps.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`PowerShell unzip failed with exit code ${code}`));
      });
    });

    console.log('🎉 Extraction successful!');
    
    // Clean up zip
    try { fs.unlinkSync(go2rtcZipPath); } catch (e) {}

    startGo2rtc();
  } catch (err) {
    console.error(`❌ Failed to download/extract go2rtc: ${err.message}`);
    console.error('Please ensure internet connection is active or download go2rtc manually and place it in the ./bin folder.');
  }
}

// Boot the go2rtc server
function startGo2rtc() {
  if (go2rtcProcess) return;

  const configPath = path.join(process.cwd(), 'go2rtc.yaml');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `
api:
  listen: ":${GO2RTC_PORT}"
rtsp:
  listen: ":8554"
webrtc:
  listen: ":8555"
`);
    console.log('📝 Created go2rtc.yaml configuration file.');
  }

  console.log(`🎬 Booting go2rtc backend on port ${GO2RTC_PORT}...`);
  go2rtcProcess = spawn(go2rtcPath, [], { cwd: process.cwd() });

  go2rtcProcess.stdout.on('data', (data) => {
    const text = data.toString().trim();
    if (text) console.log(`[go2rtc] ${text}`);
  });

  go2rtcProcess.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) console.log(`[go2rtc-err] ${text}`);
  });

  go2rtcProcess.on('close', (code) => {
    console.log(`🔴 go2rtc process exited with code ${code}`);
    go2rtcProcess = null;
  });
}

// --- MCP SSE Server JSON-RPC Client Handshake & Session Management ---

const ALGORITHM_MAP = {
  'face_recognition': 'Face Recognition',
  'object_recognition': 'Object Recognition',
  'face_expression': 'Object Classification', // 감정인식은 객체분류 카테고리 매핑
  'object_tracking': 'Object Tracking',
  'line_tracking': 'Line Tracking',
  'color_recognition': 'Color Recognition',
  'tag_recognition': 'Tag Recognition'
};

class McpSessionManager {
  constructor() {
    this.sessions = new Map(); // ip -> session object
  }

  async getSession(ip) {
    if (this.sessions.has(ip)) {
      const session = this.sessions.get(ip);
      if (session.initialized) {
        return session;
      }
    }
    return this.connect(ip);
  }

  connect(ip) {
    return new Promise((resolve, reject) => {
      // Clean up previous connection if any
      if (this.sessions.has(ip)) {
        this.closeSession(ip);
      }

      const sseUrl = `http://${ip}:3000/sse`;
      console.log(`🔗 [MCP Manager] Connecting to HuskyLens2 SSE: ${sseUrl}`);
      
      const session = {
        postEndpoint: '',
        initialized: false,
        sseReq: null,
        sseRes: null,
        step: 'init',
        pendingRequests: new Map()
      };
      
      this.sessions.set(ip, session);

      const req = http.get(sseUrl, {
        headers: {
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        }
      }, (res) => {
        session.sseRes = res;
        let buffer = '';
        let currentEvent = '';

        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('event:')) {
              currentEvent = trimmed.substring(6).trim();
            } else if (trimmed.startsWith('data:')) {
              const dataStr = trimmed.substring(5).trim();
              
              if (currentEvent === 'endpoint') {
                session.postEndpoint = dataStr;
                console.log(`🎯 [MCP Manager] Caught MCP Post Endpoint: ${session.postEndpoint}`);
                // Step 1: Send 'initialize' JSON-RPC message
                this.sendInitialize(ip, session.postEndpoint);
              } else if (currentEvent === 'message') {
                try {
                  const parsed = JSON.parse(dataStr);
                  if (session.step === 'init' && parsed.result && parsed.id === 1) {
                    session.step = 'initialized';
                    console.log('🔌 [MCP Manager] Initialize response received. Activating session...');
                    this.sendInitializedNotification(ip, session.postEndpoint)
                      .then(() => {
                        session.initialized = true;
                        console.log('✅ [MCP Manager] Session fully handshaked and active.');
                        resolve(session);
                      })
                      .catch(err => {
                        reject(err);
                      });
                  } else if (parsed.id !== undefined && session.pendingRequests.has(parsed.id)) {
                    console.log(`🎯 [MCP Manager] Found matching pending request for id: ${parsed.id}`);
                    const pending = session.pendingRequests.get(parsed.id);
                    clearTimeout(pending.timeout);
                    session.pendingRequests.delete(parsed.id);
                    
                    if (parsed.error) {
                      pending.reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
                    } else {
                      pending.resolve(parsed.result);
                    }
                  }
                } catch (e) {
                  console.error('[MCP Manager] SSE JSON parsing error:', e);
                }
              }
            } else if (trimmed === '') {
              currentEvent = '';
            }
          }
        });

        res.on('close', () => {
          console.log(`🔴 [MCP Manager] SSE connection closed for ${ip}`);
          this.closeSession(ip);
        });

        res.on('error', (err) => {
          console.error(`❌ [MCP Manager] SSE connection error for ${ip}:`, err.message);
          this.closeSession(ip);
          reject(err);
        });
      });

      session.sseReq = req;

      req.on('error', (err) => {
        console.error(`❌ [MCP Manager] SSE request error for ${ip}:`, err.message);
        this.closeSession(ip);
        reject(err);
      });

      // 6s connection timeout
      setTimeout(() => {
        if (!session.initialized) {
          req.destroy();
          this.closeSession(ip);
          reject(new Error(`Timeout waiting for MCP Handshake on ${ip}`));
        }
      }, 6000);
    });
  }

  closeSession(ip) {
    if (this.sessions.has(ip)) {
      const session = this.sessions.get(ip);
      if (session.sseReq) {
        try { session.sseReq.destroy(); } catch(e){}
      }
      this.sessions.delete(ip);
      console.log(`🔌 [MCP Manager] Cleared session for ${ip}`);
    }
  }

  sendInitialize(ip, postEndpoint) {
    const targetUrl = new URL(postEndpoint, `http://${ip}:3000`);
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'HuskyVisionClient',
          version: '1.0.0'
        }
      }
    });

    const req = http.request(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      console.log(`📤 [MCP Manager] POST initialize status: ${res.statusCode}`);
    });
    req.on('error', (err) => console.error('[MCP Manager] Initialize request error:', err.message));
    req.write(payload);
    req.end();
  }

  sendInitializedNotification(ip, postEndpoint) {
    return new Promise((resolve, reject) => {
      const targetUrl = new URL(postEndpoint, `http://${ip}:3000`);
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {}
      });

      const req = http.request(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        console.log(`📤 [MCP Manager] POST notifications/initialized status: ${res.statusCode}`);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Failed to send initialized notification: HTTP ${res.statusCode}`));
        }
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

const mcpManager = new McpSessionManager();

/**
 * Dispatches a JSON-RPC tools/call packet and awaits the corresponding SSE message response
 */
function callMcpTool(huskyIp, session, toolName, args) {
  return new Promise((resolve, reject) => {
    const postEndpoint = session.postEndpoint;
    let targetUrl;
    if (postEndpoint.startsWith('http://') || postEndpoint.startsWith('https://')) {
      targetUrl = new URL(postEndpoint);
    } else {
      // Relative path mapping
      targetUrl = new URL(postEndpoint, `http://${huskyIp}:3000`);
    }

    // Generate a unique numeric request ID
    const requestId = Math.floor(Math.random() * 100000000);

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    });

    // Register pending request callbacks with a 5 second timeout
    const timeout = setTimeout(() => {
      if (session.pendingRequests.has(requestId)) {
        session.pendingRequests.delete(requestId);
        reject(new Error(`MCP Tool call timeout for tool ${toolName} (id: ${requestId})`));
      }
    }, 5000);

    session.pendingRequests.set(requestId, { resolve, reject, timeout });

    console.log(`📤 Dispatching JSON-RPC Tool call to: ${targetUrl.toString()}`);
    console.log(`   Arguments: ${JSON.stringify(args)} (id: ${requestId})`);

    const req = http.request(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      // The POST itself is just 202 Accepted. The response will arrive over the SSE connection.
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let body = '';
        res.on('data', chunk => { body += chunk.toString(); });
        res.on('end', () => {
          clearTimeout(timeout);
          session.pendingRequests.delete(requestId);
          reject(new Error(`MCP POST failed: HTTP ${res.statusCode} -> ${body}`));
        });
      } else {
        res.resume(); // Consume the stream
      }
    });

    req.on('error', (err) => {
      clearTimeout(timeout);
      session.pendingRequests.delete(requestId);
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

// --- Unified Node.js API server ---

const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url || '', `http://${req.headers.host}`);

  // Endpoint: API Control bridge that maps natural language parsed tools to the MCP server
  if (reqUrl.pathname === '/api/control' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const { targetIp, mode, parameter, commandType } = JSON.parse(body);
        if (!targetIp) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing targetIp parameter' }));
          return;
        }

        // Bridge request to MCP protocol via persistent session
        const session = await mcpManager.getSession(targetIp);
        let mcpResponse;

        if (commandType === 'learn') {
          // Trigger multimedia learning or dynamic parameter
          mcpResponse = await callMcpTool(targetIp, session, 'multimedia_control', {
            operation: 'take_photo',
            label: parameter || 'target'
          });
        } else {
          // Map standard shorthand algorithm keys to exact official hardware names
          const mappedAlgorithm = ALGORITHM_MAP[mode] || mode;
          console.log(`🔄 Algorithm mode switch requested: "${mode}" mapped to "${mappedAlgorithm}"`);

          // Switch vision algorithms on HuskyLens 2
          mcpResponse = await callMcpTool(targetIp, session, 'manage_applications', {
            operation: 'switch_application',
            algorithm: mappedAlgorithm
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, mcpResponse }));

      } catch (err) {
        console.error(`❌ MCP Bridge error: ${err.message}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Endpoint: Fetch Real-Time Object Recognition Result from HuskyLens 2 MCP Server
  if (reqUrl.pathname === '/api/recognition' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const { targetIp } = JSON.parse(body);
        if (!targetIp) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing targetIp parameter' }));
          return;
        }

        console.log(`🔍 [stream-broker] Fetching recognition result from HuskyLens 2 MCP at ${targetIp}...`);
        const session = await mcpManager.getSession(targetIp);
        const mcpResponse = await callMcpTool(targetIp, session, 'get_recognition_result', { operation: 'get_result' });
        
        console.log(`✅ [stream-broker] Raw Tool Response:`, JSON.stringify(mcpResponse));
        
        // Parse out blocks from the MCP tool response content
        // The MCP response structure is: { isError: false, content: [ { type: "text", text: "[{...}, ...]" } ] }
        let blocks = [];
        if (mcpResponse && mcpResponse.content && Array.isArray(mcpResponse.content)) {
          const textBlock = mcpResponse.content.find(c => c.type === 'text');
          if (textBlock && textBlock.text) {
            try {
              const parsed = JSON.parse(textBlock.text);
              if (Array.isArray(parsed)) {
                // Each item has: { algorithm, content, height, id, name, width, xCenter, yCenter }
                blocks = parsed.map((item, idx) => ({
                  id: item.id !== undefined ? item.id : idx,
                  label: item.name || item.label || 'Unknown',
                  x: item.xCenter !== undefined ? item.xCenter : (item.x || 0),
                  y: item.yCenter !== undefined ? item.yCenter : (item.y || 0),
                  width: item.width || 0,
                  height: item.height || 0,
                  algorithm: item.algorithm,
                  confidence: item.confidence || 0
                }));
              } else if (parsed && Array.isArray(parsed.blocks)) {
                blocks = parsed.blocks;
              } else if (parsed && typeof parsed === 'object') {
                blocks = parsed.blocks || parsed.objects || [];
              }
            } catch (e) {
              console.log('Failed to parse textBlock.text as JSON, raw content: ', textBlock.text);
            }
          }
        } else if (mcpResponse && Array.isArray(mcpResponse.blocks)) {
          blocks = mcpResponse.blocks;
        } else if (mcpResponse && Array.isArray(mcpResponse)) {
          blocks = mcpResponse;
        } else if (mcpResponse && typeof mcpResponse === 'object') {
          blocks = mcpResponse.blocks || mcpResponse.objects || [];
        }

        console.log(`✅ [stream-broker] Extracted ${blocks.length} blocks:`, JSON.stringify(blocks));
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { blocks: blocks } }));
      } catch (err) {
        console.error(`❌ [stream-broker] MCP get_recognition_result error: ${err.message}`);
        
        // Fallback: If hardware is not connected or fails, send empty result
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: false, 
          error: err.message,
          fallbackData: {
            objects: []
          }
        }));
      }
    });
    return;
  }

  // Endpoint: Connectivity & Handshake Verification
  if (reqUrl.pathname === '/api/ping') {
    const huskyIp = reqUrl.searchParams.get('ip');
    if (!huskyIp) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'IP is required' }));
      return;
    }

    try {
      // Connect/Fetch persistent session
      const session = await mcpManager.getSession(huskyIp);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ online: true, postEndpoint: session.postEndpoint }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ online: false, error: err.message }));
    }
    return;
  }

  // Endpoint: Dynamic streaming initiation (maps RTSP to go2rtc stream 'husky')
  if (reqUrl.pathname === '/api/stream/start') {
    const huskyIp = reqUrl.searchParams.get('ip');
    if (!huskyIp) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'IP is required' }));
      return;
    }

    const rtspUrl = `rtsp://${huskyIp}:8554/live`;
    console.log(`🔄 Mapping RTSP stream in go2rtc: ${rtspUrl}`);

    // Call go2rtc HTTP API using PUT to dynamically map/update the RTSP source to "husky" stream
    const go2rtcApiUrl = `http://localhost:${GO2RTC_PORT}/api/streams?name=husky&src=${encodeURIComponent(rtspUrl)}`;
    
    const reqGo2rtc = http.request(go2rtcApiUrl, { method: 'PUT' }, (resGo2rtc) => {
      let resBody = '';
      resGo2rtc.on('data', c => { resBody += c.toString(); });
      resGo2rtc.on('end', () => {
        console.log(`📡 go2rtc Stream Map Response (${resGo2rtc.statusCode}): ${resBody}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `RTSP stream mapped to go2rtc as 'husky'` }));
      });
    });

    reqGo2rtc.on('error', (err) => {
      console.error(`❌ go2rtc connection failed: ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Could not reach go2rtc server. Details: ${err.message}` }));
    });

    reqGo2rtc.end();
    return;
  }

  // Endpoint: Local WebRTC signaling proxy to bypass browser CORS issues
  if (reqUrl.pathname === '/api/stream/webrtc' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      console.log(`📡 Forwarding WebRTC offer to go2rtc on localhost:${GO2RTC_PORT}...`);
      const go2rtcSignalingUrl = `http://localhost:${GO2RTC_PORT}/api/webrtc?src=husky`;
      
      const reqGo2rtc = http.request(go2rtcSignalingUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (resGo2rtc) => {
        let resBody = '';
        resGo2rtc.on('data', c => { resBody += c.toString(); });
        resGo2rtc.on('end', () => {
          if (resGo2rtc.statusCode >= 200 && resGo2rtc.statusCode < 300) {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(resBody);
          } else {
            console.error(`❌ go2rtc signaling failed with code ${resGo2rtc.statusCode}: ${resBody}`);
            res.writeHead(resGo2rtc.statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `go2rtc signaling failed: ${resBody}` }));
          }
        });
      });

      reqGo2rtc.on('error', (err) => {
        console.error(`❌ go2rtc connection failed during signaling: ${err.message}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Could not reach go2rtc server. Details: ${err.message}` }));
      });

      reqGo2rtc.write(body);
      reqGo2rtc.end();
    });
    return;
  }

  // Default 404
  res.writeHead(404);
  res.end();
});

// Boot servers
ensureGo2rtc().then(() => {
  server.listen(PORT, () => {
    console.log(`🌐 Stream Proxy Server listening on http://localhost:${PORT}`);
  });
});
