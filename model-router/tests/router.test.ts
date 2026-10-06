import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// O que fica abaixo do plugin: gateway, prompt, status e o request do modelo.
const world = (on: On, env: Record<string, string>, answers: unknown) => {
  const seen = { urls: [] as string[], model: '', body: null as any }
  mock.env(on, env)
  mock.clock(on)
  on('http.fetch', (_$, e) => {
    seen.urls.push(e.url)
    seen.body = JSON.parse(String(e.init?.body ?? 'null'))
    const text = JSON.stringify({ answers, model: 'typesafe-ai/jev' })
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('turn.step', async function* (_$, e) {
    seen.model = e.model
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return seen
}

const step = async ($: any, agentId?: string) => {
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId })) {
  }
}

const user = { origin: { kind: 'composer' }, wait: false } as const

const cmd = ($: any, args?: string) =>
  $.command.run({ command: 'router', args: args ?? '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

const OPUS = { tier: { type: 'choice', choice: 'opus', probabilities: { haiku: 0, sonnet: 0, opus: 1 }, confidence: 1 } }

test('roteia o turno para o modelo que o classificador escolheu', async ($, on) => {
  const seen = world(on, { AI_GATEWAY_API_KEY: 'k' }, OPUS)
  await $.prompt.submit({ text: 'redesenhe a arquitetura do servidor', ...user })
  await step($)
  expect(seen.urls).toEqual(['https://ai-gateway.vercel.sh/v1/evaluate'])
  expect(seen.body.model).toBe('typesafe-ai/jev')
  expect(seen.body.questions.tier.type).toBe('choice')
  expect(seen.model).toBe('claude-opus-5-5')
})

test('o id de cada tier vem do userConfig', { options: { opusModel: 'claude-opus-5-6' } }, async ($, on) => {
  const seen = world(on, { AI_GATEWAY_API_KEY: 'k' }, OPUS)
  await $.prompt.submit({ text: 'redesenhe a arquitetura do servidor', ...user })
  await step($)
  expect(seen.model).toBe('claude-opus-5-6')
})

test('resposta invalida mantem o modelo atual', async ($, on) => {
  const seen = world(on, { AI_GATEWAY_API_KEY: 'k' }, { tier: { type: 'choice', choice: 'gpt' } })
  await $.prompt.submit({ text: 'oi', ...user })
  await step($)
  expect(seen.model).toBe('claude-sonnet-5-5')
})

test('sem AI_GATEWAY_API_KEY nao chama o gateway', async ($, on) => {
  const seen = world(on, {}, OPUS)
  await $.prompt.submit({ text: 'oi', ...user })
  await step($)
  expect(seen.urls).toEqual([])
  expect(seen.model).toBe('claude-sonnet-5-5')
})

test('comando nao passa pelo classificador', async ($, on) => {
  const seen = world(on, { AI_GATEWAY_API_KEY: 'k' }, OPUS)
  await $.prompt.submit({ text: '/help', ...user })
  await step($)
  expect(seen.urls).toEqual([])
})

test('subagent mantem o proprio modelo', async ($, on) => {
  const seen = world(on, { AI_GATEWAY_API_KEY: 'k' }, OPUS)
  await $.prompt.submit({ text: 'redesenhe a arquitetura do servidor', ...user })
  await step($, 'a1')
  expect(seen.model).toBe('claude-sonnet-5-5')
})

test('notificacao de tarefa nao passa pelo classificador', async ($, on) => {
  const seen = world(on, { AI_GATEWAY_API_KEY: 'k' }, OPUS)
  await $.prompt.submit({ text: 'tarefa em segundo plano terminou', origin: { kind: 'task-notification' }, wait: false })
  await step($)
  expect(seen.urls).toEqual([])
  expect(seen.model).toBe('claude-sonnet-5-5')
})

test('/router opus forca o modelo sem chamar o gateway', async ($, on) => {
  const seen = world(on, { AI_GATEWAY_API_KEY: 'k' }, { tier: { type: 'choice', choice: 'haiku', confidence: 1 } })
  const out = await cmd($, 'opus')
  expect(out.text).toContain('opus')
  await $.prompt.submit({ text: 'oi', ...user })
  await step($)
  expect(seen.urls).toEqual([])
  expect(seen.model).toBe('claude-opus-5-5')
})

test('/router auto volta ao classificador', async ($, on) => {
  const seen = world(on, { AI_GATEWAY_API_KEY: 'k' }, { tier: { type: 'choice', choice: 'haiku', confidence: 1 } })
  await cmd($, 'opus')
  await cmd($, 'auto')
  await $.prompt.submit({ text: 'oi', ...user })
  await step($)
  expect(seen.urls.length).toBe(1)
  expect(seen.model).toBe('claude-haiku-4-5-20251001')
})

test('/router sem argumento mostra o estado e nao altera nada', async ($, on) => {
  world(on, { AI_GATEWAY_API_KEY: 'k' }, OPUS)
  expect((await cmd($)).text).toContain('automático')
  await cmd($, 'sonnet')
  expect((await cmd($)).text).toContain('sonnet')
})

test('/router com argumento invalido nao altera o estado', async ($, on) => {
  const seen = world(on, { AI_GATEWAY_API_KEY: 'k' }, OPUS)
  const out = await cmd($, 'gpt')
  expect(out.text).toContain('desconhecida')
  await $.prompt.submit({ text: 'oi', ...user })
  await step($)
  expect(seen.urls.length).toBe(1)
})

test('forcado vale para o loop principal e nao para subagent', async ($, on) => {
  const seen = world(on, { AI_GATEWAY_API_KEY: 'k' }, OPUS)
  await cmd($, 'haiku')
  await $.prompt.submit({ text: 'oi', ...user })
  await step($)
  expect(seen.model).toBe('claude-haiku-4-5-20251001')
  await step($, 'a1')
  expect(seen.model).toBe('claude-sonnet-5-5')
})
