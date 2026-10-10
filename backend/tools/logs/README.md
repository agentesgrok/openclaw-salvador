# tools/logs

Utilitário de inspeção dos logs do [openclaw](https://github.com/sipeed/openclaw).
Não faz parte do backend — é ferramenta de diagnóstico avulsa.

## Uso

```bash
./openclaw-logs.py                    # análise de padrões de erro (default)
./openclaw-logs.py --dump             # despeja o conteúdo recente dos logs
./openclaw-logs.py --dump --analyze   # os dois
./openclaw-logs.py --tail 200         # linhas por arquivo no dump (default: 100)
./openclaw-logs.py --logs-dir /caminho/alternativo
```

Diretório de logs, em ordem de precedência:

1. `--logs-dir`
2. `$OPENCLAW_LOGS_DIR`
3. `~/.openclaw/logs` (default)

Sai com código 1 se o diretório não existir.

## Arquivos inspecionados

`audit.log`, `status.log`, `group-blocker.log`, `launcher_panic.log` e
`picowatch_stats.json`. Os dois últimos são lidos por inteiro (arquivos
pequenos); nos demais o dump mostra apenas a cauda. A varredura de erros
ignora o `picowatch_stats.json`.

## Histórico

Consolida cinco scripts que antes viviam soltos na raiz do repositório:

| Script antigo | O que virou |
|---|---|
| `read_logs.py` | `--dump` |
| `read_logs_simple.py` | `--dump` (era duplicata do anterior) |
| `log_analyzer.py` | `--analyze` (modo default) |
| `analyze_openclaw_logs.sh` | `--dump --analyze` |
| `analyze_logs_output.sh` | `--dump --analyze` + contagem de `event=unknown` |

Os cinco tinham o path `/Users/2a/.openclaw/logs` hardcoded (macOS) e os dois
`.sh` usavam `stat -f%z`, sintaxe BSD que falha no GNU coreutils. Ambos os
problemas foram corrigidos aqui.
