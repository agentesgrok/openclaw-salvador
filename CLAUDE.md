# Claude Code — contexto do projeto

## O que é

**openclaw-mythos**: backend Node.js (Express + Socket.IO) que expõe o Claude Code CLI para o [openclaw](https://github.com/sipeed/openclaw). Usa `@anthropic-ai/claude-code` via subprocesso (`backend/claude-query.js`), autenticado por `claude login` — sem `ANTHROPIC_API_KEY`.

Duas superfícies:

1. **LLM proxy OpenAI-compatible** em `/v1` (`/v1/models`, `/v1/chat/completions`) — o OpenClaw consome como provider `mythos` (`api: openai-completions`, `baseUrl: http://127.0.0.1:3456/v1`). É o caminho principal hoje.
2. **Chat Socket.IO** (`send_message`, `message_complete`, `processing_step`, …) + REST utilitário (`/api/tasks`, `/api/sessions`, `/api/upload`, `/api/export`, `/api/skills/run`, `/api/security/scan`).

> **Histórico (2026-08-17):** o CRM Lucro Ativo (Sheets/handlers/automations/crons), o pipeline Read.ai, os bridges (Gmail/Zoho/Notion/NotebookLM), o signer, o WhatsApp inbound e os scripts de backfill foram **removidos de propósito** deste repositório. Não recriar nem referenciar `services/crm/`, `services/readai/`, `services/bridges/`. O snapshot pré-remoção está no commit `43e058e`.

## MCP no agente (WhatsApp) — como funciona

O proxy `/v1` **ignora** `tools` do request OpenAI, então `openclaw mcp add` no gateway não dá ferramenta ao agente. MCP entra **aqui**: `LLM_PROXY_MCP_CONFIG=mcp-servers.json` → o CLI sobe com `--mcp-config … --strict-mcp-config --tools "<built-ins da allowlist>"` e executa as tools dentro do próprio turno (precisa `LLM_PROXY_MAX_TURNS` > 1). `LLM_PROXY_ALLOWED_TOOLS` é allowlist real — o proxy não usa `bypassPermissions` (quem fala com ele é gente no WhatsApp). Hoje: MCP `guimoo` (Guimoo CRM, `~/.claude/mcps/guimoo-mcp`), **30 tools**: as 17 de leitura + as 13 de escrita (`create_*`, `update_*`, `delete_negociacao`, `add_tag`, `remove_tag`, `upsert_campo_negociacao`, `create_acao`, `update_acao`), liberadas pelo dono em 2026-09-21. Só o escape hatch `guimoo_request` fica de fora de propósito. `LLM_PROXY_TOOLS_GUIDANCE` anexa regras de uso ao aviso de ferramentas (orientação, não trava). Passo a passo completo: `MCP-NO-AGENTE.md`. Mudou `.env`/`mcp-servers.json` → `systemctl --user restart mythos-backend.service`.

Smoke sem WhatsApp:

```bash
cd backend && K=$(grep '^LLM_PROXY_API_KEY=' .env | cut -d= -f2-)
curl -s -m 200 http://127.0.0.1:3456/v1/chat/completions -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"Liste os funis do Guimoo. Se não tiver a ferramenta responda SEM_FERRAMENTA"}]}' | python3 -c "import json,sys;print(json.load(sys.stdin)['choices'][0]['message']['content'])"
```

## Onde mexer

| Área | Caminho |
|------|---------|
| Servidor Express + Socket.IO + rotas REST | `backend/server.js` |
| LLM proxy `/v1` (OpenAI-compatible → Claude CLI) | `backend/services/llm-proxy/openai-compat.js` |
| Spawn do CLI Claude + semáforo/memória | `backend/claude-query.js` |
| Sessões / contexto | `backend/sessionContext.js` |
| Tarefas assíncronas / modo autônomo | `backend/services/task-runner.js`, `backend/data/tasks.json` |
| Memória persistente | `backend/services/memory-store.js`, `backend/data/memory/` |
| Health check | `backend/services/health-checker.js` |
| Skills runner REST (whitelist `SKILLS_ALLOWED`) | `backend/services/skills/run-skill.js` |
| Self-scan de segurança | `backend/services/security/self-scan.js` |
| Skills em Markdown (expansão `/nome` no task-runner) | `backend/.claude/skills/**` |
| Scraper TaxLife (login/inventário/extração; requer `puppeteer` à parte) | `backend/services/scrape/taxlife/` |
| Utilitário de logs do openclaw (avulso) | `backend/tools/logs/openclaw-logs.py` |
| Testes (jest) | `backend/tests/` |

## Comandos

```bash
cd backend && npm install
cp .env.example .env    # preencher WEBHOOK_CRM_SECRET e LLM_PROXY_API_KEY (openssl rand -hex 32)
npm run dev             # nodemon
npm start               # produção (systemd/pm2 por fora)
npm test
npm run security:self-scan
```

Porta default **3456** (`PORT`). CORS/Socket.IO: `SOCKET_IO_CORS_ORIGIN`.

## Auth

- `/api/*` (exceto `/api/health` e `/api/debug/*` em dev): `Authorization: Bearer $WEBHOOK_CRM_SECRET` — função `_crmAuth` no topo do `server.js` (nome histórico; é a auth genérica REST).
- `/v1/*`: `Authorization: Bearer $LLM_PROXY_API_KEY` (fallback `WEBHOOK_CRM_SECRET`).

## Convenções

- **Node** 18+; `CLAUDE_NODE_BIN` pina o binário usado pro spawn do CLI (`/opt/node/bin/node` nesta máquina).
- CommonJS, logs via `logger` em `server.js`.
- Skills `.md` com frontmatter YAML (`name`, `description`).
- Não commitar `backend/.env`.
- Ao mudar rota/env visível, atualizar `.env.example` e este arquivo.

## Débitos conhecidos (fora do escopo da limpeza de 2026-08-17)

- `/api/translate-instagram`, `/api/instagram-stories`, `/api/translate-image` e `task-runner.js` (`LOGS_PATH`, `AGENTS_PATH`) hardcodam paths de macOS (`/Users/2a/...`) — mortos nesta máquina Linux.
- `npm audit` acusa highs em `socket.io`/`ws`/`@anthropic-ai/claude-code` — atualizar deps.
- `services/skills/run-skill.js` whitelist cita skills externas (`~/.claude/skills/*`) que podem não existir aqui.
