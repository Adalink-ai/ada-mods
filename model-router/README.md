# model-router

Mod do Claude Code que escolhe o modelo de cada turno. Antes de a requisição sair para a Anthropic, o prompt passa por um modelo de decisão (`typesafe-ai/jev`, via Vercel AI Gateway) que responde qual tier é o mais adequado: **haiku** para perguntas e edições simples, **sonnet** para o código do dia a dia, **opus** para arquitetura e raciocínio longo.

A sessão e o histórico não mudam: o mod só troca o `model` de cada requisição.

## Instalar

No terminal, em uma sessão do Claude Code:

```
/plugin install model-router --marketplace Adalink-ai/ada-mods
```

Responda `y` em `Add marketplace?`, escolha o escopo e ajuste as opções na tela de configuração (os padrões funcionam).

### Pré-requisito

Defina `AI_GATEWAY_API_KEY` (chave do [Vercel AI Gateway](https://vercel.com/docs/ai-gateway)) no ambiente do shell em que o Claude Code é iniciado. Sem ela o mod não chama o gateway e o turno segue com o modelo atual; a status line mostra `router: defina AI_GATEWAY_API_KEY`.

## Usar

### Automático

A cada prompt seu, a status line mostra a decisão:

```
router → haiku (confianca 0.97)
```

O roteador só age em prompts **escritos por você** (terminal, Remote Control ou SDK). Ficam de fora e seguem com o modelo atual: comandos `/…`, prompts vazios, notificações de tarefa em segundo plano, disparos de `/loop` ou agendamentos, mensagens de outras sessões e prompts de plugins. **Subagents** também mantêm o próprio modelo.

Se o gateway der timeout, erro ou resposta inválida, o turno segue com o modelo atual e a status line avisa. O roteador nunca bloqueia um prompt.

### Forçar um modelo: `/router`

| Comando | Efeito |
| --- | --- |
| `/router opus` | Todos os turnos usam Opus, sem chamar o classificador |
| `/router sonnet` / `/router haiku` | O mesmo para os outros tiers |
| `/router auto` | Volta ao classificador |
| `/router` | Mostra o estado atual |

Enquanto estiver forçado, a status line mostra `router: forçado → opus 🔒`. A trava vale só para a sessão em curso: uma sessão nova começa em modo automático.

## Configuração

Cada campo aparece no menu de configuração do Claude Code, ou em `settings.json`:

```json
{
  "pluginConfigs": {
    "model-router": {
      "opusModel": "claude-opus-5-6"
    }
  }
}
```

| Campo | Padrão | Descrição |
| --- | --- | --- |
| `routerModel` | `typesafe-ai/jev` | Modelo de decisão no AI Gateway |
| `gatewayUrl` | `https://ai-gateway.vercel.sh/v1/evaluate` | Endpoint de avaliação |
| `timeoutMs` | `4000` | Depois disso o turno segue com o modelo atual |
| `haikuModel` | `claude-haiku-4-5-20251001` | Id completo usado no tier haiku |
| `sonnetModel` | `claude-sonnet-5-5` | Id completo usado no tier sonnet |
| `opusModel` | `claude-opus-5-5` | Id completo usado no tier opus |

**Quando sair um modelo novo**, troque só o campo do tier. Os ids são completos de propósito: não verificamos se aliases como `opus` são resolvidos no `turn.step`.

## Privacidade

O texto do seu prompt (até 8.000 caracteres) é enviado ao endpoint configurado em `gatewayUrl` para ser classificado. Se isso não for aceitável para o seu caso, não instale o mod ou use `/router <tier>`, que não chama o gateway.

## Desenvolvimento

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
