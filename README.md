# ada-mods

Mods do [Claude Code](https://claude.com/claude-code) mantidos pela Adalink. Este repositório é um *marketplace*: cada pasta na raiz é um mod que se instala com uma linha, sem zip e sem copiar arquivos.

| Mod | O que faz |
| --- | --- |
| [`model-router`](./model-router) | Classifica cada prompt e roteia o turno para Haiku, Sonnet ou Opus. `/router` fixa um modelo. |

## Instalar

Em uma sessão do Claude Code **no terminal**:

```
/plugin install model-router --marketplace Adalink-ai/ada-mods
```

O Claude Code pergunta `Add marketplace?` (responda `y`), depois o escopo (o primeiro, *user*, vale para todas as sessões) e, se o mod tiver opções, mostra a tela de configuração. Ao final aparece `Installed model-router. Plugin is now active.` e os hooks já valem na sessão atual.

> O comando `/plugin install` só existe no terminal. A aba Code do app desktop responde que ele não está disponível, mas um mod instalado pelo terminal no escopo *user* também carrega lá.

## Estrutura do repositório

```
ada-mods/
├── .claude-plugin/
│   └── marketplace.json     # lista os mods deste marketplace
└── model-router/            # um mod = uma pasta
    ├── .claude-plugin/plugin.json   # nome, versão, userConfig
    ├── hooks/               # hooks.json + register.ts
    ├── types/index.d.ts     # contrato do estado do mod
    └── tests/               # *.test.ts, rodados por `claude plugin test`
```

Para adicionar um mod novo: crie a pasta, registre-a em `plugins` no `marketplace.json` (`"source": "./<pasta>"`) e rode `claude plugin validate .` na raiz.

## Desenvolver

```bash
claude plugin validate .                 # marketplace + manifesto + hooks
claude plugin test model-router          # testes do mod
claude --plugin-dir ./model-router       # roda o mod direto da pasta, sem instalar
```

Para o `tsc`, o Claude Code gera os tipos da API em `<mod>/.claude-plugin/types/` na primeira vez que o mod carrega (essa pasta está no `.gitignore`); depois disso, `tsc -p model-router` funciona.
