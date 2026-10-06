# adaflow-governance

Mod do Claude Code que registra a atividade de desenvolvimento na trilha de auditoria do Adaflow (módulo **Governança**), como o **usuário logado**. O login é feito pelo navegador (device flow) e o mod envia **apenas metadados**: nunca o texto do prompt, código ou saída de ferramenta.

Requer Claude Code **2.1.291** ou mais recente (versão com Mods / function hooks).

## Instalar

No terminal, em uma sessão do Claude Code:

```
/plugin install adaflow-governance --marketplace Adalink-ai/ada-mods
```

Responda `y` em `Add marketplace?` (se for a primeira vez), escolha o escopo (*user* vale para todas as sessões) e mantenha as opções padrão.

## Login

```
/adaflow login
```

1. O mod pede um código ao gateway e mostra o **código** e o **link** da página de aprovação (no macOS o navegador abre sozinho). Enquanto espera, uma faixa acima do prompt mostra o código, o link clicável e um botão **Cancelar**.
2. No navegador, já logado na plataforma, confira se o código é **o mesmo do seu terminal**, veja a organização e o escopo pedido ("Registrar atividade de desenvolvimento na auditoria") e clique em **Autorizar**.
3. O terminal fica livre durante a espera. Quando você aprova, aparece o aviso `Adaflow: conectado (<organização>)`.

A sessão vale por no máximo **7 dias** desde o login (teto absoluto, sem renovação). Depois disso o mod avisa e pede um novo `/adaflow login`.

## Comandos

| Comando | O que faz |
|---|---|
| `/adaflow login` | Login por device flow (código + aprovação no navegador) |
| `/adaflow logout` | Encerra a sessão no servidor (`/sign-out`) e apaga o token e a fila local |
| `/adaflow status` | Organização, validade restante até o teto de 7 dias, último envio, fila pendente e último erro |

## Configuração

| Campo | Padrão | Efeito |
|---|---|---|
| `baseUrl` | `https://adalink-api-gateway.onrender.com` | Gateway da plataforma (https; http só para `localhost`) |
| `enabled` | `true` | Desligado, o mod não coleta nem envia eventos |

## O que é enviado

Eventos em lote (até 50) para `POST /v1/audit/events/batch`, com `app: "claude-code"`, `eventId` único (o reenvio de um lote não duplica a trilha) e `occurredAt`:

| Evento (`action`) | Quando | Metadados |
|---|---|---|
| `app.claude_code.session.start` | início da sessão e logo após o login | id da sessão do Claude Code, versão do Claude Code, superfície (terminal/desktop), se é interativa |
| `app.claude_code.turn.complete` | fim de cada turno (inclui subagentes) | id do turno, modelo, duração, motivo do fim, tokens de entrada/saída/cache |
| `app.claude_code.tool.denied` | uma ferramenta foi recusada por um plugin | nome da ferramenta, decisão, ids das regras do `adaflow-guard` quando foi ele |

Organização e usuário **não vão no corpo**: o servidor os tira da credencial.

## O que NÃO é enviado

- Texto do prompt, resposta do modelo, código, conteúdo de arquivos, comandos ou saída de ferramentas.
- O motivo textual de uma recusa (só os ids das regras do `adaflow-guard`, como `token-in-client`).
- Caminhos de arquivo, diretório do projeto, nome do repositório, variáveis de ambiente.

Os metadados passam por uma lista do que é aceito (números, booleanos, textos curtos) e ficam abaixo de 4 KB por evento.

## Falhas

- **Sem login**: o mod não coleta nada e não faz requisição nenhuma.
- **Rede fora / gateway instável (5xx, 429)**: os eventos ficam numa fila local (até 500) e o envio tenta de novo com espera crescente (5 s até 5 min). Nada disso bloqueia o seu trabalho.
- **Lote recusado por validação (400/403/404)**: o lote é descartado, porque reenviar não muda o resultado; `/adaflow status` mostra o último erro.
- **Sessão revogada ou vencida (401 ao renovar o JWT)**: o mod apaga o token local e avisa para rodar `/adaflow login`.

## Onde fica o token

O **session token** fica no `$.store` do mod: um **JSON em texto puro** no diretório de configuração do Claude Code, **sem keychain**. Isso só é aceitável porque a credencial é **restrita**:

- só serve para registrar eventos de auditoria (escopo `audit.ingest`); o gateway nega qualquer outra rota com `403 scope_required`;
- com o próprio session token só dá para obter o JWT, consultar a sessão e sair (`/token`, `/get-session`, `/sign-out`): não troca e-mail, não lista nem revoga sessões, não aprova outros logins;
- vale no máximo 7 dias e pode ser revogada a qualquer momento.

O JWT de 15 minutos usado nos envios fica só na memória. O mod nunca usa o app token (`x-ada-token`): toda requisição autenticada vai com `Authorization: Bearer`.

## Como revogar

- No terminal: `/adaflow logout` (encerra no servidor e apaga o arquivo local).
- Pela plataforma: na lista de sessões do seu usuário, a sessão aparece rotulada como Claude Code; revogue-a. O próximo envio recebe 401 e o mod apaga o token local.
- Perdeu a máquina? Revogue pela plataforma: o token local para de funcionar na hora.

## Limites

- **Ordem dos plugins**: `tool.denied` só é visto quando a recusa vem de um plugin que roda *abaixo* deste na cadeia de `tool.call` (como o `adaflow-guard`). Recusas do prompt de permissão do próprio Claude Code não chegam como recusa de plugin e não são registradas.
- **Login pendente e recarga**: se o mod recarregar durante a espera, o login pendente é perdido; rode `/adaflow login` de novo.
- **Catálogo de eventos** ainda a fechar com Governança (PRD, Q6).

## Desenvolvimento

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

Os testes rodam inteiramente contra mocks (rede, relógio e store), sem backend.
