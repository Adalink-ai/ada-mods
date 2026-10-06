import { atom, read, update } from 'claude-code'
import type { PromptSubmitInput, Register } from 'claude-code'

import type { Route, Tier } from '../types'

const route = atom({ plugin: 'model-router', key: 'route' } as const, null)
const forced = atom({ plugin: 'model-router', key: 'forced' } as const, null as Tier | null)

// Pergunta "choice" da decision API (/v1/evaluate): cada criterio e uma opcao possivel.
const QUESTION = {
  type: 'choice',
  instructions: 'Qual modelo Claude e o mais adequado para este pedido de um agente de programacao?',
  criteria: {
    haiku: 'perguntas simples, consultas rapidas, edicoes triviais, comandos diretos',
    sonnet: 'tarefas de codigo do dia a dia, bugs comuns, features pequenas/medias',
    opus: 'arquitetura, refatoracoes grandes, bugs dificeis, raciocinio longo, planejamento',
  },
}

const isTier = (v: unknown): v is Tier => v === 'haiku' || v === 'sonnet' || v === 'opus'

// So o que a pessoa escreveu: o composer do terminal, o Remote Control e o host do SDK.
// Notificacoes de tarefa, /loop agendado, outras sessoes e plugins ficam com o modelo atual.
const USER_ORIGINS: ReadonlySet<PromptSubmitInput['origin']['kind']> = new Set(['composer', 'bridge', 'sdk'])

const updateStatus = async ($: any) => {
  const f = await read($, forced)
  if (f) {
    $.ui.status(`router: forçado → ${f} 🔒`)
  } else {
    $.ui.status(undefined)
  }
}

export const register: Register = (on, options) => {
  const routerModel = String(options.routerModel)
  const gatewayUrl = String(options.gatewayUrl)
  const timeoutMs = Number(options.timeoutMs)
  // Ids completos vindos do userConfig: um modelo novo e so trocar a configuracao.
  const models: Record<Tier, string> = {
    haiku: String(options.haikuModel),
    sonnet: String(options.sonnetModel),
    opus: String(options.opusModel),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'router',
      description: 'Fixa o modelo do turno (haiku, sonnet, opus) ou volta ao modo automático (auto)',
    })
    return next(e)
  })

  on('command.run', { command: 'router' }, async ($, e, next) => {
    const arg = (e.args || '').trim().toLowerCase()

    if (arg === '') {
      const f = await read($, forced)
      return { text: f ? `router: forçado → ${f} 🔒` : 'router: modo automático' }
    }

    if (arg === 'auto') {
      await update($, forced, () => null as Tier | null)
      await updateStatus($)
      return { text: 'router: modo automático ativado' }
    }

    if (isTier(arg)) {
      await update($, forced, () => arg)
      await updateStatus($)
      return { text: `router: forçado para ${arg} 🔒` }
    }

    return { text: `router: opção desconhecida "${arg}". Use: haiku, sonnet, opus, auto` }
  })

  on('prompt.submit', async ($, e, next) => {
    const f = await read($, forced)

    // Se forcado, pula o classificador
    if (f) {
      $.ui.log(`router: forçado ${f}`, { to: 'debug' })
      await update($, route, () => ({ tier: f, model: models[f], reason: 'forçado' }))
      return next(e)
    }

    // Prompt entregue dentro de um turno em andamento, que nao veio da pessoa, comando ou vazio: nao reroteia.
    if (e.turnId !== undefined || !USER_ORIGINS.has(e.origin.kind) || e.text.trim() === '' || e.text.startsWith('/')) {
      $.ui.log(`router: ignorado (origin=${e.origin.kind}, turnId=${e.turnId ?? '-'})`, { to: 'debug' })
      return next(e)
    }

    const key = await $.env.get('AI_GATEWAY_API_KEY')
    if (!key) {
      $.ui.status('router: defina AI_GATEWAY_API_KEY')
      return next(e)
    }

    const ask = $.http.fetch(gatewayUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: routerModel,
        state: `Pedido do usuario: ${e.text.slice(0, 8000)}`,
        questions: { tier: QUESTION },
      }),
    })
    const res = await Promise.race([ask, $.clock.sleep(timeoutMs).then(() => null)])

    let chosen: Route | null = null
    if (res === null) {
      $.ui.status('router: timeout, modelo atual mantido')
    } else if (!res.ok) {
      $.ui.status(`router: gateway ${res.status}, modelo atual mantido`)
    } else {
      const answer = JSON.parse(res.text)?.answers?.tier
      const tier: unknown = answer?.choice
      if (isTier(tier)) {
        const confidence = Number(answer.confidence)
        const reason = Number.isFinite(confidence) ? `confianca ${confidence.toFixed(2)}` : ''
        chosen = { tier, model: models[tier], reason }
        $.ui.status(`router → ${chosen.tier}${chosen.reason ? ` (${chosen.reason})` : ''}`)
      } else {
        $.ui.status('router: resposta invalida, modelo atual mantido')
      }
    }
    $.ui.log(`router: ${chosen ? `${chosen.tier} → ${chosen.model}` : 'sem rota'}`, { to: 'debug' })

    await update($, route, () => chosen)
    return next(e)
  }).catch(async ($, e, next) => {
    // O roteador nunca bloqueia o prompt: em erro, segue com o modelo atual.
    if (!next.called) {
      await update($, route, () => null)
      $.ui.status('router: erro, modelo atual mantido')
    }
    return next(e)
  })

  // Cada requisicao do loop principal sai com o modelo escolhido; subagents ficam como estao.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const f = await read($, forced)
    const chosen = f ? { model: models[f] } : await read($, route)
    return yield* next(chosen ? { ...e, model: chosen.model } : e)
  })
}
