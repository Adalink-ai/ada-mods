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

Em modo `deny` (padrão) a ferramenta é recusada e o motivo, com a correção sugerida, volta para o modelo, que normalmente corrige sozinho. Em modo `warn` a ferramenta roda e um toast avisa. Só conta o que a edição **introduz**: um arquivo que já tinha o problema não trava edições que não o agravam.

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

- **Escrita via Bash:** só `Write` e `Edit` são inspecionados; um `echo … > arquivo` ou `sed -i` contorna as regras de arquivo.
- **Client component = diretiva `"use client"`** (Next.js App Router). Em SPAs (Vite, Create React App) todo arquivo roda no browser, mas só a regra de prefixo público (`VITE_`, `REACT_APP_`) pega.
- **Falsos positivos:** `literal-token` dispara com um valor literal de 16+ caracteres em `x-ada-token`, `appToken` ou atribuído a `ADAFLOW_APP_TOKEN`/`ADALINK_APP_TOKEN`/`ADA_TOKEN` (placeholders como `your-…`/`example` são ignorados). Fixtures de teste podem disparar; o modo `warn` serve para isso.

## Desenvolvimento

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
