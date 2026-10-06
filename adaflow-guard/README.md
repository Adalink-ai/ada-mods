# adaflow-guard

Mod do Claude Code que impede vazar o app token (`x-ada-token`) do Adaflow para o browser, para o código-fonte ou para o transcript. Funciona como guardrail: bloqueia ou avisa nas ferramentas `Write`, `Edit` e `Bash`.

## Instalar

No terminal, em uma sessão do Claude Code:

```
/plugin install adaflow-guard --marketplace Adalink-ai/ada-mods
```

Responda `y` em `Add marketplace?` (se for a primeira vez), escolha o escopo e deixe as opções padrão.

## Usar

### Automático

A cada tentativa de `Write`, `Edit` ou `Bash` que violasse as regras, o mod intervém:

| Regra | Bloqueia quando | Ferramenta |
|---|---|---|
| `token-in-client` | um arquivo `"use client"` referencia a credencial (`ADAFLOW_APP_TOKEN`, `x-ada-token`, etc.) | Write, Edit |
| `public-token-env` | o token aparece com prefixo público (`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`) | Write, Edit |
| `browser-gateway` | um client component chama o gateway direto, sem proxy | Write, Edit |
| `literal-token` | há um token hardcoded no código (placeholders e `.env` real ficam de fora) | Write, Edit |
| `token-print` | um comando imprimiria o token no transcript (`echo $ADAFLOW_APP_TOKEN`, `printenv`, etc.) | Bash |

Se uma violação for detectada, a status line ou um toast mostra o motivo e, em modo `deny` (padrão), a ferramenta é bloqueada. Você pode corrigir e tentar de novo — o mod só valida a edição em si, não o estado anterior do arquivo.

### Configuração

| Campo | Padrão | Efeito |
|---|---|---|
| `mode` | `deny` | `deny` bloqueia; `warn` deixa passar e avisa |

Mude para `warn` no menu do Claude Code se quiser auditar sem bloquear.

## Contexto

As regras seguem o [guia de integração do Adaflow](https://github.com/Adalink-ai/adalink-integration-kit/blob/main/docs/INTEGRATED-APPS-GUIDE.md):

- O **app token** é um segredo de longa duração: só servidor pode conhecer.
- O **browser** nunca fala direto com o gateway — sempre via proxy do app (`/api/adaflow/[...path]`).
- O **JWT do usuário** é curto e vive no browser por desenho; o app token não.
- Um token vindo do log (`echo`, `printenv`) vaza para qualquer leitor da sessão.

## Limites

- **Bash sofisticado:** um `echo … > arquivo` ou `sed -i` pode contornar as regras de arquivo.
- **Não é Next App Router-aware:** em SPAs (Vite, Create React App), tudo é client e só a regra de nome público vai pegar.
- **Falsos positivos:** qualquer string de 16+ caracteres sem "placeholder" nos nomes dispara `literal-token`; use modo `warn` para testar e `deny` para enforcar.

## Desenvolvimento

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
