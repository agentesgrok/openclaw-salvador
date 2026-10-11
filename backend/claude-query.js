/**
 * claude-query.js — Wrapper para o SDK v2 do Claude Code
 *
 * O SDK v2 (@anthropic-ai/claude-code) não exporta query() programaticamente.
 * Este módulo spawna o CLI e emite os mesmos eventos que a query() do SDK v1.
 *
 * Inclui semáforo de processos e throttle por memória para evitar OOM.
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const CLI_PATH = path.join(__dirname, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');

// Usa Node 22 se disponível (v1 cli.js crasha no Node 25)
const NODE_BIN = process.env.CLAUDE_NODE_BIN || 'node';

// ── Semáforo de processos ──
const MAX_PROCESSES = parseInt(process.env.MAX_CLAUDE_PROCESSES || '2');
const MEMORY_THROTTLE = parseInt(process.env.MEMORY_THROTTLE_PERCENT || '85');
const SLOT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min max de espera

let activeProcesses = 0;
const waitQueue = []; // Array de { resolve, timer }

function getMemoryUsagePercent() {
  const total = os.totalmem();
  const free = os.freemem();
  return ((total - free) / total) * 100;
}

function getActiveProcessCount() {
  return activeProcesses;
}

function isThrottled() {
  return activeProcesses >= MAX_PROCESSES || getMemoryUsagePercent() > MEMORY_THROTTLE;
}

async function acquireSlot() {
  if (activeProcesses < MAX_PROCESSES && getMemoryUsagePercent() <= MEMORY_THROTTLE) {
    activeProcesses++;
    return;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waitQueue.findIndex(w => w.resolve === wrappedResolve);
      if (idx !== -1) waitQueue.splice(idx, 1);
      reject(new Error('Throttle timeout: could not acquire process slot within 5 minutes'));
    }, SLOT_TIMEOUT_MS);

    const wrappedResolve = () => { clearTimeout(timer); resolve(); };
    waitQueue.push({ resolve: wrappedResolve });
  });
}

function releaseSlot() {
  activeProcesses = Math.max(0, activeProcesses - 1);

  if (waitQueue.length > 0 && activeProcesses < MAX_PROCESSES && getMemoryUsagePercent() <= MEMORY_THROTTLE) {
    const next = waitQueue.shift();
    activeProcesses++;
    next.resolve();
  }
}

// Polling: drenar waitQueue quando memória cair sem que um processo termine.
// unref: não segura o processo vivo sozinho (jest/scripts encerram normalmente).
setInterval(() => {
  while (waitQueue.length > 0 && activeProcesses < MAX_PROCESSES && getMemoryUsagePercent() <= MEMORY_THROTTLE) {
    const next = waitQueue.shift();
    activeProcesses++;
    next.resolve();
  }
}, 10000).unref();

// ── Query ──

async function* query({ prompt, options = {} }) {
  await acquireSlot();
  try {
    yield* _spawnQuery({ prompt, options });
  } finally {
    releaseSlot();
  }
}

async function* _spawnQuery({ prompt, options }) {
  const args = [
    CLI_PATH,
    '--output-format', 'stream-json',
    '--verbose',
    '--print',
  ];

  if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
  if (options.model) args.push('--model', options.model);
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);
  if (options.mcpConfig) args.push('--mcp-config', options.mcpConfig);
  // Ignora ~/.claude.json, .mcp.json e conectores da conta: só sobem os servers do --mcp-config
  if (options.strictMcpConfig) args.push('--strict-mcp-config');
  // Built-ins disponíveis ("" = nenhum). Sem isso o CLI carrega Bash/Read/Write/… mesmo que não estejam em allowedTools
  if (typeof options.tools === 'string') args.push('--tools', options.tools);
  if (options.allowedTools?.length) {
    for (const tool of options.allowedTools) {
      args.push('--allowedTools', tool);
    }
  }
  if (options.includePartialMessages) args.push('--include-partial-messages');

  // Prompt goes as the last argument; "--" closes any preceding variadic (e.g. --allowedTools)
  args.push('--', prompt);

  const child = spawn(NODE_BIN, args, {
    env: { ...process.env, PATH: process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: options.cwd || process.cwd(),
  });

  // Spawn falhou (ENOENT no binário/cwd etc.): vira um result de erro em vez de
  // um 'error' não tratado que derrubaria o servidor inteiro.
  child.on('error', (err) => {
    lineQueue.push({
      type: 'result',
      subtype: 'error',
      is_error: true,
      error: `spawn failed: ${err.message}`,
      result: `spawn failed: ${err.message}`,
    });
    done = true;
    if (resolve) { resolve(); resolve = null; }
  });

  // Handle abort
  if (options.abortController) {
    options.abortController.signal.addEventListener('abort', () => {
      child.kill('SIGTERM');
    });
  }

  // Stderr handler
  if (options.stderr) {
    child.stderr.on('data', (data) => options.stderr(data.toString()));
  }

  // Parse NDJSON from stdout
  let buffer = '';
  const lineQueue = [];
  let resolve;
  let done = false;

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (line.trim()) {
        try {
          lineQueue.push(JSON.parse(line));
          if (resolve) { resolve(); resolve = null; }
        } catch (e) {
          // skip malformed JSON
        }
      }
    }
  });

  child.on('close', (code) => {
    // Process remaining buffer
    if (buffer.trim()) {
      try {
        lineQueue.push(JSON.parse(buffer));
      } catch (e) {}
    }
    if (code !== 0 && lineQueue.length === 0) {
      lineQueue.push({
        type: 'result',
        subtype: 'error',
        is_error: true,
        error: `Claude Code process exited with code ${code}`,
        result: `Claude Code process exited with code ${code}`,
      });
    }
    done = true;
    if (resolve) { resolve(); resolve = null; }
  });

  // Yield messages as they arrive
  while (true) {
    while (lineQueue.length > 0) {
      yield lineQueue.shift();
    }
    if (done) break;
    await new Promise(r => { resolve = r; });
  }
}

module.exports = { query, getActiveProcessCount, isThrottled, getMemoryUsagePercent };
