# Incidente 2026-10-10 — agente parou de responder no WhatsApp

## Resumo

Na noite de 10/10/2026, o agente OpenClaw parou de responder no WhatsApp. Quem mandava mensagem recebia
**"API rate limit reached. Please try again later."**

O motivo foi que a pasta deste projeto foi renomeada de `~/openclaw-mythos` para `~/openclaw-salvador`.
O serviço `mythos-backend` (a ponte entre o OpenClaw e o Claude) aponta para o caminho
`/home/openclaw/openclaw-mythos/backend`. Quando ele reiniciou, não achou a pasta e ficou em loop de falha.

Para resolver, a pasta voltou ao nome original, `~/openclaw-mythos`. O backend subiu na hora e o agente voltou a responder.

No mesmo dia também foram feitos o update do OpenClaw, a liberação da Bianca e a configuração dela como admin
(detalhes abaixo). Nenhuma dessas mudanças causou o incidente.

---

## Linha do tempo (UTC)

| Hora  | Evento |
|-------|--------|
| ~21:05 | Pasta `~/openclaw-mythos` renomeada para `~/openclaw-salvador`. O backend continua rodando, porque já estava em memória. |
| 21:21 | Backup verificado do OpenClaw antes do update. |
| 21:22–21:27 | Update do OpenClaw de 2026.7.1-2 para 2026.9.9, mais o update do plugin WhatsApp. WhatsApp volta `healthy`. |
| 21:29 | Número da Bianca (+55 21 99619-6614) adicionado à allowlist de DMs. |
| 21:31:41 | O `mythos-backend` cai ("Claude Code process exited with code 1"), porque a pasta de trabalho não existe mais. |
| 21:31:46 em diante | O systemd tenta reiniciar a cada 5 s e falha sempre com `status=200/CHDIR` (pasta não encontrada). |
| 21:33 | Agente manda um "oi" para a Bianca (entregue). |
| 21:34 | Bianca e Salvador adicionados como admins (`commands.ownerAllowFrom`). |
| 21:35–21:40 | Bianca escreve, mas o agente não consegue gerar resposta e devolve a mensagem de erro de rate limit. |
| ~21:40 | Pasta renomeada de volta para `~/openclaw-mythos`. Backend sobe às 21:40:31. |
| 21:42 | Bianca manda nova mensagem. O agente responde em áudio em 19 s, sem erro. ✅ |

---

## Por que a mensagem era de "rate limit" se o problema era outro

O agente usa uma cadeia de modelos (em `~/.openclaw/openclaw.json`, `agents.defaults.model`):

1. `mythos/claude-sonnet-5`, que é o principal e passa por este backend (`http://127.0.0.1:3456/v1`)
2. `mythos/claude-opus-4-8`, que também passa por este backend
3. `google/gemini-2.5-pro`, que é o reserva

Com o backend fora do ar, os dois primeiros davam **conexão recusada** (`ECONNREFUSED`). O OpenClaw então caía
no Gemini, que estava **sem cota** (erro 429). Por isso o erro que aparecia para o usuário era de "rate limit".
Esse era só o último erro da cadeia, e a causa real estava no backend.

---

## Como diagnosticar se acontecer de novo

```bash
# 1. O WhatsApp está conectado?
openclaw channels status

# 2. O backend mythos está de pé? (deve dar "active" e "200")
systemctl --user is-active mythos-backend
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3456/v1/models

# 3. Por que o backend não sobe?
journalctl --user -u mythos-backend -n 30 --no-pager
#   "status=200/CHDIR" / "Changing to the requested working directory failed"
#   = a pasta do WorkingDirectory não existe (renomeada/movida/apagada)

# 4. O que o agente está tentando e onde falha?
journalctl --user -u openclaw-gateway --since "-10 min" --no-pager | grep -E "Inbound|Sent|agent end"
#   "provider=mythos ... connection refused"  -> backend fora do ar
#   "provider=google ... 429"                 -> Gemini sem cota (só fallback)
```

## Como corrigir

**Opção A (a usada neste incidente):** voltar a pasta para o nome que o serviço espera.

```bash
mv ~/openclaw-salvador ~/openclaw-mythos
systemctl --user restart mythos-backend
```

**Opção B:** manter o nome novo e atualizar o serviço.

```bash
U=~/.config/systemd/user/mythos-backend.service
cp $U ~/Backups/openclaw/mythos-backend.service.bak
sed -i 's#/home/openclaw/openclaw-mythos/backend#/home/openclaw/<NOVO-NOME>/backend#' $U
systemctl --user daemon-reload
systemctl --user restart mythos-backend
```

Antes de renomear, verifique se não há outras referências ao caminho antigo:

```bash
grep -rn "openclaw-mythos" ~/.config/systemd/user/ ~/.openclaw/openclaw.json
```

Em 10/10, só o arquivo do serviço `mythos-backend` usava esse caminho.

**Testar o backend direto (sem passar pelo WhatsApp):**

```bash
K=$(python3 -c "import json;print(json.load(open('/home/openclaw/.openclaw/openclaw.json'))['models']['providers']['mythos']['apiKey'])")
curl -s -m 120 http://127.0.0.1:3456/v1/chat/completions \
  -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"Responda só: ok"}]}'
```

> ⚠️ **Regra:** não renomeie nem mova `~/openclaw-mythos` sem atualizar o `mythos-backend.service` junto.
> O backend continua funcionando até o próximo restart, então a falha aparece só depois.

---

## Outras mudanças feitas no mesmo dia

### 1. Update do OpenClaw 2026.7.1-2 → 2026.9.9

- **Backup antes:** `~/Backups/openclaw/2026-10-10T21-21-32.091+00-00-openclaw-backup.tar.gz` (verificado).
- `openclaw update` falhou com `EACCES`, porque o OpenClaw está instalado como **root** em `/opt/node`. Nada foi alterado.
- Procedimento manual que funcionou:

  ```bash
  openclaw gateway stop
  sudo env PATH=/opt/node/bin:$PATH /opt/node/bin/npm install -g openclaw@2026.9.9 \
    --allow-scripts=@google/genai,esbuild,koffi,protobufjs,openclaw
  openclaw doctor --fix          # reinicia o gateway
  openclaw plugins update whatsapp
  openclaw gateway restart
  ```

- **Atenção:** depois de atualizar o core, o plugin do WhatsApp (ainda na versão 2026.7.1) quebrou com
  `cannot import openclaw/plugin-sdk/...`. Foi resolvido com `openclaw plugins update whatsapp`. Em updates futuros,
  sempre rodar esse comando (ou `openclaw update`, que já faz isso sozinho quando tem permissão).
- O npm 11.17 bloqueia scripts de instalação por padrão, por isso é preciso passar `--allow-scripts=...`.
- O WhatsApp ficou fora por uns 5 minutos durante o update.

### 2. Bianca liberada no WhatsApp

- Número **+55 21 99619-6614** adicionado em `channels.whatsapp.allowFrom` nos dois formatos
  (`+5521996196614` e `+552196196614`), aplicado a quente.

### 3. Bianca e Salvador como admins

- `commands.ownerAllowFrom` em `~/.openclaw/openclaw.json` passou a ter:
  `whatsapp:+554797534316` (o próprio agente, já estava), Salvador (`+5547997298179` / `+554797298179`)
  e Bianca (`+5521996196614` / `+552196196614`).
  Antes, o Salvador **não estava** nessa lista.
- `~/.openclaw/workspace/USER.md` agora diz que a Bianca é admin, com a mesma autoridade do Salvador para configuração.

---

## Pendências / pontos de atenção

- **Gemini sem cota:** o modelo reserva não está funcionando. Se o backend cair de novo, não há fallback útil.
  Vale revisar o plano/billing do Google ou trocar o fallback.
- **Sessão de DM compartilhada:** as conversas privadas da Bianca e do Salvador caem na mesma sessão
  (`agent:main:main`), então o agente mistura o contexto das duas. Dá para separar por pessoa na config do OpenClaw.
- **`USER.md`:** ainda diz que a hierarquia de confiança "só muda via configuração feita pelo Salvador".
  Precisa ajustar se a Bianca também puder autorizar números novos.
- **Token do gateway em texto puro** no `openclaw.json` (aviso do `openclaw doctor`).
- O nome do serviço no systemd ainda mostra "v2026.7.1-2". É só cosmético, e `openclaw gateway install --force` atualiza.
