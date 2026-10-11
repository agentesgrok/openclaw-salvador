# Claude Code — contexto do projeto

## O que é

**openclaw-mythos**: backend Node.js (Express + Socket.IO) que expõe o Claude Code CLI para o [openclaw](https://github.com/sipeed/openclaw). Usa `@anthropic-ai/claude-code` via subprocesso (`backend/claude-query.js`), autenticado por `claude login` — sem `ANTHROPIC_API_KEY`.

Duas superfícies:

1. **LLM proxy OpenAI-compatible** em `/v1` (`/v1/models`, `/v1/chat/completions`) — o OpenClaw consome como provider `mythos` (`api: openai-completions`, `baseUrl: http://127.0.0.1:3456/v1`). É o caminho principal hoje.
2. **Chat Socket.IO** (`send_message`, `message_complete`, `processing_step`, …) + REST utilitário (`/api/tasks`, `/api/sessions`, `/api/upload`, `/api/export`, `/api/security/scan`).

> **Histórico (2026-10-11):** limpeza para deixar o backend agnóstico de domínio. Saíram: o scraper TaxLife (`services/scrape/taxlife/` → repo próprio `taxlife-scraper` no GitHub), as rotas Instagram/LinkedIn (`/api/translate-instagram`, `/api/instagram-stories`, `/api/translate-image`), o runner de skills (`/api/skills/run`, `services/skills/`), o modo autônomo do task-runner (`/api/autonomous/*`, missões, auto-commit-PR) e o utilitário `tools/logs`. A auth REST passou a `API_SECRET` / `requireAuth` (nome antigo `WEBHOOK_CRM_SECRET` segue aceito como fallback). Não recriar nada disso aqui.
>
> **Histórico (2026-08-17):** o CRM Lucro Ativo (Sheets/handlers/automations/crons), o pipeline Read.ai, os bridges (Gmail/Zoho/Notion/NotebookLM), o signer, o WhatsApp inbound e os scripts de backfill foram **removidos de propósito** deste repositório. Não recriar nem referenciar `services/crm/`, `services/readai/`, `services/bridges/`. O snapshot pré-remoção está no commit `43e058e`.

## MCP no agente (WhatsApp) — como funciona

O proxy `/v1` **ignora** `tools` do request OpenAI, então `openclaw mcp add` no gateway não dá ferramenta ao agente. MCP entra **aqui**: `LLM_PROXY_MCP_CONFIG=mcp-servers.json` → o CLI sobe com `--mcp-config … --strict-mcp-config --tools "<built-ins da allowlist>"` e executa as tools dentro do próprio turno (precisa `LLM_PROXY_MAX_TURNS` > 1). `LLM_PROXY_ALLOWED_TOOLS` é allowlist real — o proxy não usa `bypassPermissions` (quem fala com ele é gente no WhatsApp). Hoje: MCP `guimoo` (Guimoo CRM, `~/.claude/mcps/guimoo-mcp`), **30 tools**: as 17 de leitura + as 13 de escrita (`create_*`, `update_*`, `delete_negociacao`, `add_tag`, `remove_tag`, `upsert_campo_negociacao`, `create_acao`, `update_acao`), liberadas pelo dono em 2026-09-21. Só o escape hatch `guimoo_request` fica de fora de propósito. `LLM_PROXY_TOOLS_GUIDANCE` anexa regras de uso ao aviso de ferramentas (orientação, não trava). Mudou `.env`/`mcp-servers.json` → `systemctl --user restart mythos-backend.service` e depois `npm run test:e2e`.

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
| Fila de tarefas assíncronas (`/api/tasks`) | `backend/services/task-runner.js`, `backend/data/tasks.json` |
| Memória persistente | `backend/services/memory-store.js`, `backend/data/memory/` |
| Health check | `backend/services/health-checker.js` |
| Self-scan de segurança | `backend/services/security/self-scan.js` |
| Skills em Markdown (expansão `/nome` no task-runner; pasta opcional, hoje não existe) | `backend/.claude/skills/**` |
| Testes (jest) | `backend/tests/` |

## Comandos

```bash
cd backend && npm install
cp .env.example .env    # preencher API_SECRET e LLM_PROXY_API_KEY (openssl rand -hex 32)
npm run dev             # nodemon
npm start               # produção (systemd/pm2 por fora)
npm test
npm run security:self-scan
```

Porta default **3456** (`PORT`). CORS/Socket.IO: `SOCKET_IO_CORS_ORIGIN`.

## Deploy (systemd de usuário)

```bash
./deploy/install-service.sh            # grava ~/.config/systemd/user/mythos-backend.service e (re)inicia
./deploy/install-service.sh --dry-run  # só mostra o unit
```

O script calcula o `WorkingDirectory` a partir da própria pasta do repo, então **o nome/caminho da pasta não importa** (`openclaw-mythos`, `openclaw-salvador`, VPS nova…). Renomeou ou moveu a pasta → rode o script de novo antes de qualquer restart; foi a causa do incidente de 2026-10-10 (`RENOMEADO.md`). Mudou `.env`/`mcp-servers.json`/código → `systemctl --user restart mythos-backend.service` e depois o e2e abaixo.

## Teste e2e real (`backend/tests/e2e/`)

Prova que **o agente do WhatsApp continua funcionando** depois de restart/deploy/mudança: gateway OpenClaw → `/v1` do mythos → Claude CLI → MCP Guimoo. Roda contra a **produção** (3456), gasta tokens de verdade e não envia nada ao WhatsApp (usa `openclaw agent` numa sessão descartável `agent:main:e2e-<ts>`, apagada no fim).

```bash
cd backend
npm run test:e2e:preflight   # ~10 s, sem token: serviços, portas, auth, chaves iguais gateway↔backend, CLI, MCP no disco, WhatsApp
npm run test:e2e:backend     # + POST /v1 direto: texto, stream SSE, Guimoo read-only (list_funis → FUNIS=<n>)
npm run test:e2e             # + turno completo pelo gateway (texto e Guimoo), checando que NÃO caiu no fallback Gemini
npm run test:e2e -- --json   # relatório JSON (stdout)
```

Exit `0` ok · `1` algo quebrou (a coluna `[hint]` diz a camada: `backend down`, `auth mismatch`, `CLI broken`, `MCP broken`, `gateway down`, `fallback happened`, `whatsapp disconnected`) · `2` inconclusivo (slot do CLI ocupado por usuário real, outra execução, orçamento). Nunca roda em paralelo: `MAX_CLAUDE_PROCESSES=1` → um turno de teste ocupa o único slot. Não está no `npm test` (jest) de propósito. Não agendar: sob demanda.

## Auth

- `/api/*` (exceto `/api/health` e `/api/debug/*` em dev): `Authorization: Bearer $API_SECRET` — função `requireAuth` no topo do `server.js`. `WEBHOOK_CRM_SECRET` é o nome antigo e ainda funciona como fallback.
- `/v1/*`: `Authorization: Bearer $LLM_PROXY_API_KEY` (fallback `API_SECRET`).

## Convenções

- **Node** 18+; `CLAUDE_NODE_BIN` pina o binário usado pro spawn do CLI (`/opt/node/bin/node` nesta máquina).
- CommonJS, logs via `logger` em `server.js`.
- Skills `.md` com frontmatter YAML (`name`, `description`).
- Não commitar `backend/.env`.
- Ao mudar rota/env visível, atualizar `.env.example` e este arquivo.

## Débitos conhecidos

- `npm audit` acusa highs em `socket.io`/`ws`/`@anthropic-ai/claude-code` — atualizar deps.
