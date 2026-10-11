require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { query, isThrottled } = require('./claude-query');
const SessionContextManager = require('./sessionContext');
const HealthChecker = require('./services/health-checker');
const taskRunner = require('./services/task-runner');

// Logger com níveis — TRACE só aparece em development
const logger = {
  debug: (...args) => { if (process.env.NODE_ENV === 'development') console.log(...args); },
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

// Auth Bearer dos endpoints REST (/api/*): header "Authorization: Bearer $API_SECRET".
// WEBHOOK_CRM_SECRET é o nome antigo da mesma variável — aceito como fallback.
// Comparação em tempo constante. Retorna false já tendo respondido 401/500.
function requireAuth(req, res) {
  const expected = process.env.API_SECRET || process.env.WEBHOOK_CRM_SECRET;
  if (!expected) {
    res.status(500).json({ ok: false, error: 'API_SECRET nao configurado' });
    return false;
  }
  const auth = req.headers.authorization || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = Buffer.from(presented), b = Buffer.from(expected);
  const ok = a.length === b.length && require('crypto').timingSafeEqual(a, b);
  if (!ok) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return false;
  }
  return true;
}

const app = express();
const server = http.createServer(app);
const ALLOWED_ORIGINS = (process.env.SOCKET_IO_CORS_ORIGIN || 'http://localhost:5173').split(',').map(s => s.trim());

const io = socketIo(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"]
  }
});

app.use(cors({ origin: ALLOWED_ORIGINS }));

// ── LLM proxy OpenAI-compatible (/v1/models, /v1/chat/completions) ──
// Montado ANTES do express.json() global (limite 100kb) — o router tem parser próprio (20mb).
// Consumido pelo OpenClaw como provider `mythos` (api: openai-completions).
taskRunner.setIo(io); // eventos task_* via Socket.IO
app.use('/v1', require('./services/llm-proxy/openai-compat').router);

app.use(express.json());

// Storage for uploaded files
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'uploads';
    fs.ensureDirSync(uploadDir);
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow text files and common code files
    const allowedTypes = [
      'text/plain',
      'text/javascript',
      'text/html',
      'text/css',
      'application/json',
      'application/javascript'
    ];
    
    const allowedExtensions = [
      '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h',
      '.css', '.html', '.json', '.xml', '.yaml', '.yml', '.md', '.txt',
      '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.scala', '.sql'
    ];
    
    const ext = path.extname(file.originalname).toLowerCase();
    const isAllowedType = allowedTypes.includes(file.mimetype);
    const isAllowedExt = allowedExtensions.includes(ext);
    
    if (isAllowedType || isAllowedExt || file.mimetype.startsWith('text/')) {
      cb(null, true);
    } else {
      cb(new Error('Only text and code files are allowed'), false);
    }
  }
});

// In-memory session storage (in production, use Redis or database)
const sessions = new Map();
const activeConnections = new Map();
// Sistema de deduplicação de mensagens
const processedMessages = new Map();

const MESSAGE_TTL = 30000; // 30 seconds

// Limpeza automática de mensagens antigas
setInterval(() => {
  const now = Date.now();
  for (const [messageId, timestamp] of processedMessages.entries()) {
    if (now - timestamp > MESSAGE_TTL) {
      processedMessages.delete(messageId);
    }
  }
}, 60000); // Limpar a cada minuto

// Limpeza de sessões sem atividade (4 horas)
setInterval(() => {
  const now = Date.now();
  const SESSION_TTL = 4 * 60 * 60 * 1000;
  let cleaned = 0;
  for (const [sessionId, data] of sessions.entries()) {
    if (data.lastActivity && (now - data.lastActivity > SESSION_TTL)) {
      sessions.delete(sessionId);
      cleaned++;
    }
  }
  if (cleaned > 0) logger.info(`🧹 Cleaned ${cleaned} stale sessions`);
}, 3600000); // A cada hora

// Função para detectar se um erro é de limite do Claude
function isClaudeLimitError(errorMsg) {
  if (!errorMsg) return false;
  return errorMsg.includes('Claude AI usage limit reached') ||
         errorMsg.includes('usage limit') ||
         errorMsg.includes('rate limit');
}

// Função para extrair timestamp de reset da mensagem de erro
function extractResetTime(errorMsg) {
  if (!errorMsg) return null;

  // Tentar extrair timestamp direto: "Claude AI usage limit reached|1234567890"
  let match = errorMsg.match(/Claude AI usage limit reached\|(\d+)/);
  if (!match) {
    match = errorMsg.match(/\{"type":\s*"text",\s*"text":\s*"Claude AI usage limit reached\|(\d+)"\s*\}/);
  }

  if (match) {
    const resetTimestamp = parseInt(match[1]);
    const resetDate = new Date(resetTimestamp * 1000);
    const day = resetDate.getDate();
    const hour = resetDate.getHours();
    const min = resetDate.getMinutes();
    return {
      timestamp: resetTimestamp,
      date: resetDate,
      formatted: `dia ${day}, ${hour}:${String(min).padStart(2, '0')}h`
    };
  }

  return null;
}

// Wrapper legado para compatibilidade com endpoint /api/claude-reset-info
async function getClaudeResetTime() {
  // Não spawnar processo extra — retornar null se não temos info em cache
  return null;
}

// Initialize clients
const sessionContextManager = new SessionContextManager();

// Initialize Health Checker
const healthChecker = new HealthChecker();

// Initialize all systems
async function initializeSystem() {
  console.log('🚀 Initializing Chat Server Systems...');

  try {
    console.log('📋 System Status:');
    console.log('  Session Context: ✅ Active');

  } catch (error) {
    console.error('❌ System initialization error:', error);
  }
}

// Initialize on startup
initializeSystem();

// Helper functions for processing step messages
function getStepMessage(stepType, msg) {
  switch (stepType) {
    case 'thinking':
      return 'Claude está analisando sua mensagem...';
    case 'tool_use':
      return `Executando ${msg.name || 'ferramenta'}: ${getToolDescription(msg.name, msg.input)}`;
    case 'tool_result':
      const success = !msg.is_error && msg.content;
      return `${msg.tool_use_id?.slice(0, 8) || 'Execução'} ${success ? 'concluída' : 'falhou'}`;
    case 'result':
      if (msg.is_error) {
        return `Erro: ${msg.error || 'Erro desconhecido'}`;
      }
      return `Resposta gerada (${msg.result?.length || 0} caracteres, ${msg.num_turns || 1} turnos)`;
    case 'streaming':
      return 'Enviando resposta...';
    case 'stream_event':
      return 'Recebendo resposta em tempo real...';
    case 'sending':
      return 'Enviando mensagem para o Claude...';
    case 'cancelled':
      return 'Mensagem cancelada.';
    case 'user':
      return 'Recebendo mensagem...';
    case 'assistant':
      return 'Claude está respondendo...';
    case 'system':
      return 'Preparando contexto...';
    default:
      return `Processando: ${stepType}`;
  }
}

function getToolDescription(toolName, input) {
  switch (toolName) {
    case 'Read':
      return `Lendo arquivo: ${input?.file_path?.split('/').pop() || 'arquivo'}`;
    case 'Write':
      return `Escrevendo arquivo: ${input?.file_path?.split('/').pop() || 'arquivo'}`;
    case 'Edit':
      return `Editando arquivo: ${input?.file_path?.split('/').pop() || 'arquivo'}`;
    case 'Bash':
      return `Executando comando: ${input?.command?.substring(0, 50) || 'comando'}${input?.command?.length > 50 ? '...' : ''}`;
    case 'Glob':
      return `Buscando arquivos: ${input?.pattern || 'padrão'}`;
    case 'Grep':
      return `Buscando conteúdo: ${input?.pattern || 'padrão'}`;
    case 'LS':
      return `Listando diretório: ${input?.path?.split('/').pop() || 'diretório'}`;
    case 'Task':
      return `Iniciando sub-agente: ${input?.description || 'tarefa'}`;
    case 'WebFetch':
      return `Acessando URL: ${input?.url || 'página web'}`;
    case 'WebSearch':
      return `Pesquisa web: ${input?.query || 'consulta'}`;
    default:
      return toolName ? `Operação ${toolName}` : 'Operação desconhecida';
  }
}

function getStepData(msg) {
  const data = { 
    type: msg.type,
    timestamp: Date.now(),
    messageId: generateShortId()
  };
  
  switch (msg.type) {
    case 'tool_use':
      data.toolName = msg.name;
      data.toolId = msg.id;
      data.toolInput = msg.input;
      data.inputSummary = getInputSummary(msg.name, msg.input);
      data.expectedOutput = getExpectedOutput(msg.name, msg.input);
      data.toolDescription = getDetailedToolDescription(msg.name);
      break;
      
    case 'tool_result':
      data.toolUseId = msg.tool_use_id;
      data.hasError = !!msg.is_error;
      data.contentLength = msg.content?.length;
      data.contentType = getContentType(msg.content);
      data.errorDetails = msg.is_error ? msg.content : null;
      data.executionStatus = msg.is_error ? 'failed' : 'success';
      data.outputSummary = getOutputSummary(msg.content);
      break;
      
    case 'result':
      data.isError = msg.is_error;
      data.duration = msg.duration_ms;
      data.cost = msg.total_cost_usd;
      data.turns = msg.num_turns;
      data.inputTokens = msg.input_tokens;
      data.outputTokens = msg.output_tokens;
      data.cacheReads = msg.cache_read_tokens;
      data.cacheWrites = msg.cache_write_tokens;
      
      if (msg.result) {
        data.responseLength = msg.result.length;
        data.responseWords = msg.result.split(/\s+/).length;
        data.responseLines = msg.result.split('\n').length;
        data.hasCodeBlocks = /```/.test(msg.result);
        data.hasMarkdown = /[#*`\[\]]/.test(msg.result);
      }
      
      if (msg.error) {
        data.errorType = getErrorType(msg.error);
        data.errorMessage = msg.error;
      }
      break;
      
    case 'thinking':
      data.cognitiveLoad = 'processing';
      data.analysisPhase = 'understanding_request';
      data.strategizing = true;
      break;
      
    default:
      data.unknownType = true;
      break;
  }
  
  return data;
}

function generateShortId() {
  return Math.random().toString(36).substr(2, 8);
}

function getInputSummary(toolName, input) {
  if (!input) return 'No input provided';
  
  switch (toolName) {
    case 'Read':
      return `File: ${input.file_path?.split('/').pop()} (${input.limit ? `first ${input.limit} lines` : 'entire file'})`;
    case 'Write':
      return `File: ${input.file_path?.split('/').pop()} (${input.content?.length || 0} characters)`;
    case 'Edit':
      return `File: ${input.file_path?.split('/').pop()} (${input.old_string?.length || 0} → ${input.new_string?.length || 0} chars)`;
    case 'Bash':
      return `Command: ${input.command} ${input.timeout ? `(timeout: ${input.timeout}ms)` : ''}`;
    case 'Glob':
      return `Pattern: ${input.pattern} in ${input.path || 'current directory'}`;
    case 'Grep':
      return `Pattern: /${input.pattern}/ in ${input.include || 'all files'}`;
    default:
      return Object.keys(input).map(k => `${k}: ${String(input[k]).substring(0, 30)}`).join(', ');
  }
}

function getExpectedOutput(toolName, input) {
  switch (toolName) {
    case 'Read':
      return 'File contents with line numbers';
    case 'Write':
      return 'File creation confirmation';
    case 'Edit':
      return 'File modification confirmation';
    case 'Bash':
      return 'Command output and exit status';
    case 'Glob':
      return 'List of matching file paths';
    case 'Grep':
      return 'Files containing the search pattern';
    case 'LS':
      return 'Directory listing with file details';
    case 'Task':
      return 'Sub-agent execution results';
    default:
      return 'Tool-specific output';
  }
}

function getDetailedToolDescription(toolName) {
  switch (toolName) {
    case 'Read':
      return 'Reads file contents from the filesystem with optional line limits and offsets';
    case 'Write':
      return 'Creates or overwrites files with provided content';
    case 'Edit':
      return 'Performs exact string replacements in existing files';
    case 'Bash':
      return 'Executes shell commands in a persistent session with timeout controls';
    case 'Glob':
      return 'Searches for files matching glob patterns with modification time sorting';
    case 'Grep':
      return 'Searches file contents using regular expressions with file filtering';
    case 'LS':
      return 'Lists directory contents with detailed file information';
    case 'Task':
      return 'Spawns independent agent instances for complex subtasks';
    case 'WebFetch':
      return 'Fetches and processes web content with AI analysis';
    case 'WebSearch':
      return 'Performs web searches with result filtering and ranking';
    default:
      return 'Specialized tool for specific operations';
  }
}

function getContentType(content) {
  if (!content) return 'empty';
  if (typeof content !== 'string') return typeof content;
  
  if (content.includes('Error:') || content.includes('error:')) return 'error_message';
  if (content.match(/^\s*\{.*\}\s*$/s)) return 'json';
  if (content.match(/^\s*<.*>\s*$/s)) return 'xml_html';
  if (content.includes('```')) return 'code_block';
  if (content.split('\n').length > 10) return 'multiline_text';
  
  return 'text';
}

// Extrai texto de qualquer formato de resposta do Claude Code SDK
function extractTextContent(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) {
    return data
      .filter(item => item.type === 'text' && item.text)
      .map(item => item.text)
      .join('\n');
  }
  if (typeof data === 'object') {
    if (data.type === 'text' && data.text) return data.text;
    if (data.content) return extractTextContent(data.content);
    if (data.message) return extractTextContent(data.message);
    if (data.text) return String(data.text);
    return JSON.stringify(data, null, 2);
  }
  return String(data);
}

function getOutputSummary(content) {
  if (!content) return 'No output';
  
  const lines = content.split('\n').length;
  const words = content.split(/\s+/).length;
  const chars = content.length;
  
  let summary = `${chars} chars, ${words} words, ${lines} lines`;
  
  if (content.includes('Error:')) summary += ' (contains errors)';
  if (content.includes('```')) summary += ' (contains code)';
  if (content.match(/\.(js|ts|py|java|cpp|c|go|rs|php|rb)$/)) summary += ' (source code)';
  
  return summary;
}

function getErrorType(error) {
  if (!error) return 'unknown';
  
  const errorStr = error.toString().toLowerCase();
  
  if (errorStr.includes('timeout')) return 'timeout';
  if (errorStr.includes('permission')) return 'permission_denied';
  if (errorStr.includes('not found') || errorStr.includes('enoent')) return 'file_not_found';
  if (errorStr.includes('syntax')) return 'syntax_error';
  if (errorStr.includes('network') || errorStr.includes('fetch')) return 'network_error';
  if (errorStr.includes('memory') || errorStr.includes('oom')) return 'memory_error';
  
  return 'general_error';
}


// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    // Use cached status if available and recent
    const cached = healthChecker.getCachedStatus();
    if (cached && !req.query.force) {
      return res.json(cached);
    }

    // Perform full health check
    const healthStatus = await healthChecker.performFullCheck({
      io
    });

    // Set appropriate HTTP status code based on health
    const httpStatus = healthStatus.status === 'unhealthy' ? 503 : 
                       healthStatus.status === 'degraded' ? 200 : 200;

    res.status(httpStatus).json(healthStatus);
  } catch (error) {
    console.error('❌ [HEALTH] Health check error:', error);
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// File upload endpoint
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const content = await fs.readFile(filePath, 'utf8');
    
    // Clean up uploaded file after reading
    await fs.remove(filePath);
    
    res.json({
      success: true,
      filename: req.file.originalname,
      content: content,
      size: req.file.size,
      mimetype: req.file.mimetype
    });
  } catch (error) {
    console.error('File upload error:', error);
    res.status(500).json({ 
      error: 'Failed to process file',
      details: error.message 
    });
  }
});

// Export conversation endpoint
app.post('/api/export', async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const { messages, format = 'markdown' } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages data' });
    }
    
    let content = '';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    if (format === 'markdown') {
      content += `# Claude UI Chat Agent SDK Export\n\n`;
      content += `Generated on: ${new Date().toLocaleString()}\n\n`;
      content += `---\n\n`;
      
      messages.forEach((msg, index) => {
        const role = msg.type === 'user' ? 'User' : 'Claude';
        content += `## ${role} (${new Date(msg.timestamp).toLocaleTimeString()})\n\n`;
        content += `${msg.content}\n\n`;
        
        if (msg.type === 'assistant' && (msg.cost || msg.duration || msg.turns)) {
          content += `*Metadata: `;
          const meta = [];
          if (msg.cost) meta.push(`Cost: $${msg.cost.toFixed(4)}`);
          if (msg.duration) meta.push(`Duration: ${msg.duration.toFixed(0)}ms`);
          if (msg.turns) meta.push(`Turns: ${msg.turns}`);
          content += meta.join(' • ') + '*\n\n';
        }
        
        content += `---\n\n`;
      });
    } else if (format === 'json') {
      content = JSON.stringify({
        export_date: new Date().toISOString(),
        message_count: messages.length,
        messages: messages
      }, null, 2);
    }
    
    const filename = `claude-ui-agent-${timestamp}.${format === 'json' ? 'json' : 'md'}`;
    
    res.setHeader('Content-Type', format === 'json' ? 'application/json' : 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Failed to export conversation' });
  }
});

const requireDevMode = (req, res, next) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).json({ error: 'Debug endpoints disabled in production' });
  }
  next();
};

app.get('/api/debug/session/:sessionId', requireDevMode, async (req, res) => {
  const { sessionId } = req.params;

  try {
    const sessionData = sessions.get(sessionId);
    const contextFormatted = await sessionContextManager.getFormattedContext(sessionId, "[PRÓXIMA MENSAGEM]");
    const stats = await sessionContextManager.getStats();

    res.json({
      sessionId,
      exists: !!sessionData,
      messageCount: sessionData ? sessionData.messages.length : 0,
      messages: sessionData ? sessionData.messages.slice(-20) : [],
      contextPreview: contextFormatted,
      stats,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/dialogs', requireDevMode, async (req, res) => {
  try {
    const dialogs = [];

    for (const [sessionId, sessionData] of sessions.entries()) {
      const lastMessage = sessionData.messages[sessionData.messages.length - 1];

      dialogs.push({
        sessionId,
        title: sessionData.title || 'Sessão sem título',
        messageCount: sessionData.messages.length,
        createdAt: sessionData.createdAt,
        lastActivity: sessionData.lastActivity,
        lastMessage: lastMessage ? {
          type: lastMessage.type,
          preview: lastMessage.content ? lastMessage.content.substring(0, 100) + '...' : '',
          timestamp: lastMessage.timestamp
        } : null
      });
    }

    res.json({
      activeDialogs: dialogs.length,
      dialogs,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para obter informações do próximo reset do Claude
app.get('/api/claude-reset-info', async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    // Tentar obter info do timestamp real do Claude
    const resetInfo = await getClaudeResetTime();
    
    if (resetInfo && resetInfo.timestamp) {
      res.json({
        success: true,
        resetTimestamp: resetInfo.timestamp,
        resetDate: resetInfo.date,
        formatted: resetInfo.formatted
      });
    } else {
      // Se não tem info do Claude, verificar se temos salvo quando o limite foi atingido
      res.json({
        success: false,
        message: 'No reset information available'
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Session management endpoints
app.get('/api/sessions', (req, res) => {
  if (!requireAuth(req, res)) return;
  const sessionList = Array.from(sessions.entries()).map(([id, data]) => ({
    id: id,
    created: data.created,
    lastActivity: data.lastActivity,
    messageCount: data.messages ? data.messages.length : 0,
    title: data.title || `Session ${id.slice(0, 8)}...`
  }));
  
  res.json({ sessions: sessionList });
});

app.get('/api/sessions/:sessionId', (req, res) => {
  if (!requireAuth(req, res)) return;
  const sessionData = sessions.get(req.params.sessionId);
  if (!sessionData) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  res.json(sessionData);
});

app.delete('/api/sessions/:sessionId', (req, res) => {
  if (!requireAuth(req, res)) return;
  const deleted = sessions.delete(req.params.sessionId);
  res.json({ success: deleted });
});

// ══════════════════════════════════════════════
// Task Runner — REST Endpoints
// ══════════════════════════════════════════════

// POST /api/tasks — submete tarefa autônoma
app.post('/api/tasks', express.json(), (req, res) => {
  if (!requireAuth(req, res)) return;
  const { prompt, workspace, systemPrompt, maxTurns, model, tags, source } = req.body;
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  const task = taskRunner.createTask({ prompt, workspace, systemPrompt, maxTurns, model, tags, source });
  res.json({ success: true, task: _sanitizeTask(task) });
});

// GET /api/tasks — listar tasks
app.get('/api/tasks', (req, res) => {
  if (!requireAuth(req, res)) return;
  const { status, source, limit } = req.query;
  const list = taskRunner.listTasks({ status, source, limit: parseInt(limit) || 50 });
  res.json({ tasks: list.map(_sanitizeTask) });
});

// GET /api/tasks/:id — detalhes de uma task
app.get('/api/tasks/:id', (req, res) => {
  if (!requireAuth(req, res)) return;
  const task = taskRunner.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(_sanitizeTask(task));
});

// DELETE /api/tasks/:id — cancelar task
app.delete('/api/tasks/:id', (req, res) => {
  if (!requireAuth(req, res)) return;
  const cancelled = taskRunner.cancelTask(req.params.id);
  res.json({ success: cancelled });
});

// POST /api/tasks/:id/retry — reenviar task que falhou
app.post('/api/tasks/:id/retry', (req, res) => {
  if (!requireAuth(req, res)) return;
  const original = taskRunner.getTask(req.params.id);
  if (!original) return res.status(404).json({ error: 'Task not found' });
  if (!['error', 'cancelled'].includes(original.status)) {
    return res.status(400).json({ error: `Cannot retry task with status: ${original.status}` });
  }
  const task = taskRunner.createTask({
    prompt: original.prompt,
    workspace: original.workspace,
    systemPrompt: original.systemPrompt,
    maxTurns: original.maxTurns,
    model: original.model,
    tags: original.tags,
    source: original.source,
  });
  res.json({ success: true, task: _sanitizeTask(task) });
});

// ── Self-scan de segurança (auth coverage, stack trace leak, env misconfig, npm audit, upload limits) ──
// Não substitui DAST (ZAP) nem SAST (Semgrep) — é camada interna que conhece o próprio código.
app.post('/api/security/scan', async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const result = await require('./services/security/self-scan').runScan();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function _sanitizeTask(task) {
  const { _abortController, _timeoutId, ...safe } = task;
  return safe;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  logger.info('Client connected:', socket.id);
  activeConnections.set(socket.id, { connectedAt: Date.now() });
  let currentAbortController = null;

  // Send connection stats
  socket.emit('connection_stats', {
    active_connections: activeConnections.size,
    active_sessions: sessions.size
  });

  // Cancelar mensagem em andamento
  socket.on('cancel_message', () => {
    if (currentAbortController && !currentAbortController.signal.aborted) {
      currentAbortController.abort();
      socket.emit('typing_end');
      socket.emit('processing_step', {
        step: 'cancelled',
        message: 'Mensagem cancelada.',
        timestamp: Date.now()
      });
    }
  });

  // CONSOLIDATED MESSAGE HANDLER - Único ponto de processamento
  socket.on('send_message', async (data) => {
    // Gerar ID único para esta mensagem
    const messageId = `${socket.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Verificar se mensagem já foi processada
    if (processedMessages.has(messageId) || 
        (data.messageId && processedMessages.has(data.messageId))) {
      logger.debug('🔄 DEDUP: ignoring:', messageId);
      return;
    }
    
    // Marcar mensagem como sendo processada
    const finalMessageId = data.messageId || messageId;
    processedMessages.set(finalMessageId, Date.now());
    
    logger.debug('📥 Processing message:', finalMessageId);
    
    try {
      const {
        message,
        sessionId,
        systemPrompt,
        maxTurns = 5,
        allowedTools = [],
        customOptions = {}
      } = data;
      
      if (!message || !message.trim()) {
        logger.debug('❌ Empty message rejected');
        socket.emit('error', { 
          error: 'Message cannot be empty',
          messageId: finalMessageId
        });
        // Remover da lista de processadas já que falhou
        processedMessages.delete(finalMessageId);
        return;
      }
      
      logger.debug('✅ Message validated:', {
        messagePreview: message.substring(0, 100),
        sessionId: sessionId,
        hasSystemPrompt: !!systemPrompt
      });

      // Generate session ID if not provided
      const currentSessionId = sessionId || uuidv4();
      
      // Get or create session
      let sessionData = sessions.get(currentSessionId) || {
        id: currentSessionId,
        created: Date.now(),
        messages: [],
        title: message.length > 50 ? message.substring(0, 50) + '...' : message
      };

      // Add user message to session
      const userMessage = {
        id: uuidv4(),
        type: 'user',
        role: 'user', // IMPORTANTE: Adicionar role para consistência
        content: message,
        timestamp: Date.now()
      };
      
      sessionData.messages.push(userMessage);
      sessionData.lastActivity = Date.now();
      sessions.set(currentSessionId, sessionData);
      
      // Emit user message
      socket.emit('message', {
        ...userMessage,
        role: userMessage.role || userMessage.type || 'user', // Garantir que role está definido
        sessionId: currentSessionId
      });
      
      logger.debug('📤 User message emitted:', userMessage.id);
      
      // Prepare Claude Code query options
      const queryOptions = {
        maxTurns: maxTurns,
        includePartialMessages: true,  // Streaming real token a token
      };

      // Adicionar mensagem do usuário ao contexto da sessão
      await sessionContextManager.addToContext(currentSessionId, 'user', message);

      // Obter mensagem com contexto da conversa
      let finalPrompt = await sessionContextManager.getFormattedContext(currentSessionId, message);

      // System prompt via SDK (melhor que concatenar strings)
      if (systemPrompt) {
        queryOptions.appendSystemPrompt = systemPrompt;
      }

      // Tools
      if (allowedTools.length > 0) {
        queryOptions.allowedTools = allowedTools;
      }

      // Novos recursos do SDK via customOptions
      if (customOptions.model) queryOptions.model = customOptions.model;
      if (customOptions.fallbackModel) queryOptions.fallbackModel = customOptions.fallbackModel;
      if (customOptions.maxThinkingTokens) queryOptions.maxThinkingTokens = customOptions.maxThinkingTokens;
      queryOptions.permissionMode = customOptions.permissionMode || process.env.CLAUDE_DEFAULT_PERMISSION_MODE || 'bypassPermissions';

      // AbortController com timeout
      const QUERY_TIMEOUT = parseInt(process.env.QUERY_TIMEOUT) || 120000;
      currentAbortController = new AbortController();
      const timeoutId = setTimeout(() => currentAbortController.abort(), QUERY_TIMEOUT);
      queryOptions.abortController = currentAbortController;

      logger.debug('⏳ Starting Claude query:', { sessionId: currentSessionId, model: queryOptions.model || 'default' });

      socket.emit('typing_start');
      if (isThrottled()) {
        socket.emit('processing_step', {
          sessionId: currentSessionId,
          step: 'queued',
          message: 'Aguardando vaga — sistema em throttle por uso de memória.',
          timestamp: Date.now()
        });
      }
      socket.emit('processing_step', {
        sessionId: currentSessionId,
        step: 'sending',
        message: 'Enviando mensagem para o Claude...',
        data: { promptLength: finalPrompt.length, maxTurns: queryOptions.maxTurns, model: queryOptions.model || 'default' },
        timestamp: Date.now()
      });

      let assistantResponse = '';
      let streamBuffer = '';
      let responseMetadata = {};
      const messages = [];

      try {
        // Capturar stderr do processo claude para debug
        queryOptions.stderr = (data) => logger.debug('🔴 Claude stderr:', data);

        for await (const msg of query({ prompt: finalPrompt, options: queryOptions })) {
          messages.push(msg);
          logger.debug('🔄 Claude msg:', msg.type);
          
          // Emit real-time processing steps
          socket.emit('processing_step', {
            sessionId: currentSessionId,
            step: msg.type,
            message: getStepMessage(msg.type, msg),
            data: getStepData(msg),
            timestamp: Date.now()
          });
          
          // Handle different message types from Claude Code SDK
          if (msg.type === 'result') {
            // Capture final metadata
            responseMetadata = {
              cost: msg.total_cost_usd,
              duration: msg.duration_ms,
              turns: msg.num_turns,
              is_error: msg.is_error
            };
            
            if (!msg.is_error && msg.result) {
              let resultStr = extractTextContent(msg.result);

              // Processar mensagem de limite do Claude
              if (resultStr.includes('Claude AI usage limit reached|')) {
                const timestampMatch = resultStr.match(/Claude AI usage limit reached\|(\d+)/);
                if (timestampMatch) {
                  const resetTimestamp = parseInt(timestampMatch[1]);
                  const resetDate = new Date(resetTimestamp * 1000);
                  resultStr = `🕐 Seu limite será resetado: dia ${resetDate.getDate()}, ${resetDate.getHours()}h`;
                  socket.emit('typing_end');
                }
              }

              assistantResponse = resultStr;
              socket.emit('message_stream', {
                sessionId: currentSessionId,
                content: resultStr,
                fullContent: streamBuffer || resultStr
              });

            } else if (msg.is_error) {
              assistantResponse = `Error: ${msg.error || 'Unknown error occurred'}`;
              logger.error('❌ Claude error:', msg.error);
            }

          // Streaming real token a token (includePartialMessages)
          } else if (msg.type === 'stream_event' && msg.event) {
            if (msg.event.type === 'content_block_delta' && msg.event.delta?.text) {
              streamBuffer += msg.event.delta.text;
              socket.emit('message_stream', {
                sessionId: currentSessionId,
                content: msg.event.delta.text,
                fullContent: streamBuffer
              });
            }

          } else if (msg.type === 'thinking') {
            logger.debug('💭 Claude thinking...');
          } else if (msg.type === 'tool_use' || msg.type === 'tool_result') {
            logger.debug('🔧 Tool:', msg.type, msg.name || msg.tool_use_id);
          } else if (msg.type === 'assistant' && msg.message) {
            const extracted = extractTextContent(msg.message);
            if (extracted) {
              assistantResponse = extracted;
              logger.debug('📝 Assistant msg:', extracted.substring(0, 100));
            }
          }
        }

        clearTimeout(timeoutId);
        logger.debug('🏁 Claude query completed');
        
        socket.emit('processing_step', {
          sessionId: currentSessionId,
          step: 'finalizing',
          message: 'Finalizando resposta...',
          timestamp: Date.now()
        });
        
        socket.emit('typing_end');
        
        // Validar e garantir que assistantResponse é string
        if (typeof assistantResponse !== 'string') {
          logger.warn('⚠️ Non-string response, extracting text:', typeof assistantResponse);
          assistantResponse = extractTextContent(assistantResponse);
        }
        if (!assistantResponse || assistantResponse.trim() === '') {
          logger.warn('⚠️ Empty response, metadata:', responseMetadata);
          assistantResponse = "Resposta vazia do Claude. Tente reformular a pergunta.";
        }
        
        // Create assistant message
        const assistantMessage = {
          id: uuidv4(),
          type: 'assistant',
          content: assistantResponse,
          timestamp: Date.now(),
          ...responseMetadata
        };
        
        // Adicionar resposta do assistente ao contexto da sessão
        await sessionContextManager.addToContext(currentSessionId, 'assistant', assistantResponse);
        
        logger.debug('💾 Saving:', assistantMessage.id);

        // Save to session
        sessionData.messages.push(assistantMessage);
        sessionData.lastActivity = Date.now();
        sessions.set(currentSessionId, sessionData);
        
        socket.emit('message_complete', {
          ...assistantMessage,
          sessionId: currentSessionId
        });
        
      } catch (error) {
        clearTimeout(timeoutId);
        logger.error('❌ Claude query error:', error.message);
        socket.emit('typing_end');

        // Detectar tipo de erro
        let errorContent = `Erro: ${error.message}`;

        if (error.name === 'AbortError' || error.message?.includes('abort')) {
          errorContent = 'Tempo limite excedido ou mensagem cancelada.';
        } else if (isClaudeLimitError(error.message)) {
          const resetInfo = extractResetTime(error.message);
          if (resetInfo) {
            errorContent = `🕐 Limite do Claude atingido. Reset: ${resetInfo.formatted}`;
          } else {
            errorContent = `🕐 Limite do Claude atingido. Verifique /usage no Claude Code para detalhes.`;
          }
        }

        const errorMessage = {
          id: uuidv4(),
          type: 'assistant',
          content: errorContent,
          timestamp: Date.now(),
          is_error: true
        };
        
        sessionData.messages.push(errorMessage);
        sessions.set(currentSessionId, sessionData);
        
        socket.emit('error', {
          ...errorMessage,
          sessionId: currentSessionId
        });
      }
      
    } catch (error) {
      console.error('Message handling error:', error);
      
      // Send error message in the correct format
      const errorMessage = {
        id: uuidv4(),
        type: 'assistant',
        content: `Desculpe, não consegui processar sua solicitação corretamente. Por favor, tente novamente.\n\nDetalhes do erro: ${error.message}`,
        timestamp: Date.now(),
        is_error: true
      };
      
      socket.emit('error', {
        ...errorMessage,
        sessionId: data?.sessionId || 'default'
      });
    }
  });


  // Handle file analysis requests
  socket.on('analyze_file', async (data) => {
    try {
      const { content, filename, prompt = 'Analyze this code file' } = data;
      
      if (!content) {
        socket.emit('error', { error: 'No file content provided' });
        return;
      }
      
      const analysisPrompt = `${prompt}

File: ${filename}
Content:
\`\`\`
${content}
\`\`\`

Please provide a thorough analysis of this file.`;
      
      // Trigger analysis using the same message flow
      socket.emit('send_message', {
        message: analysisPrompt,
        maxTurns: 3
      });
      
    } catch (error) {
      console.error('File analysis error:', error);
      socket.emit('error', { 
        error: 'Failed to analyze file',
        details: error.message 
      });
    }
  });
  
  // Handle session management
  socket.on('load_session', (sessionId) => {
    const sessionData = sessions.get(sessionId);
    if (sessionData) {
      socket.emit('session_loaded', sessionData);
    } else {
      socket.emit('error', { error: 'Session not found' });
    }
  });
  
  socket.on('create_session', () => {
    const newSessionId = uuidv4();
    const sessionData = {
      id: newSessionId,
      created: Date.now(),
      messages: [],
      title: 'Nova Sessão'
    };
    
    sessions.set(newSessionId, sessionData);
    socket.emit('session_created', sessionData);
  });
  
  // Handle session deletion
  socket.on('delete_session', (sessionId) => {
    console.log('🗑️ Deleting session:', sessionId);
    const deleted = sessions.delete(sessionId);
    
    if (deleted) {
      // Notify all connected clients about the deletion
      io.emit('session_deleted', {
        success: true,
        sessionId: sessionId,
        remainingSessions: sessions.size,
        timestamp: Date.now()
      });
      
      console.log('✅ Session deleted successfully:', sessionId);
    } else {
      socket.emit('session_deleted', {
        success: false,
        sessionId: sessionId,
        error: 'Session not found',
        timestamp: Date.now()
      });
      
      console.log('❌ Session not found for deletion:', sessionId);
    }
  });
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    activeConnections.delete(socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log('🚀 Enhanced Claude Code SDK Server running on port', PORT);
  console.log('📋 Features enabled:');
  console.log('  • Real-time streaming chat');
  console.log('  • File upload and analysis');
  console.log('  • Session management');
  console.log('  • Conversation export');
  console.log('  • Advanced Claude Code SDK integration');
  console.log('  • WebSocket connections for real-time updates');
  
  // Start health monitoring
  healthChecker.startMonitoring({
    io
  }, 30000); // Check every 30 seconds
  console.log('  • Real-time metrics and monitoring');
});