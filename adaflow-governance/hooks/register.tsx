import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { FLUSH_EVERY_MS, Governance, guardRuleIds } from './governance'

const login = atom({ plugin: 'adaflow-governance', key: 'login' } as const, null)

const USAGE = 'Uso: `/adaflow login [endereco]` | `/adaflow logout` | `/adaflow status`'

export const register: Register = (on, options) => {
  const cfg = { baseUrl: String(options.baseUrl ?? ''), enabled: options.enabled !== false }
  let gov: Governance | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // `$` e o mesmo objeto em toda invocacao: a Io guarda chamadas inline a ele para os timers.
    gov ??= new Governance(
      {
        fetch: (url, init) => $.http.fetch(url, init),
        now: () => $.clock.now(),
        get: key => $.store.get(key),
        set: (key, value) => $.store.set(key, value),
        del: key => $.store.delete(key),
        after: (ms, fn) => $.clock.after(ms, fn),
        toast: text => $.ui.toast(text, { timeoutMs: 8000 }),
        log: text => $.ui.log(text, { to: 'debug' }),
        setLogin: value => update($, login, () => value),
        openUrl: async url => {
          // So no macOS e so com alguem no terminal; qualquer falha fica em silencio.
          if (!e.isInteractive) return
          const os = await $.process.run(['uname', '-s'], { timeoutMs: 2000 })
          if (os.stdout.trim() !== 'Darwin') return
          await $.process.run(['open', url], { timeoutMs: 5000 })
        },
      },
      cfg,
    )
    await gov.load()
    gov.sessionId = await $.session.id().catch(() => null)
    await $.command.register({
      name: 'adaflow',
      description: 'Adaflow: login, logout e status da trilha de auditoria',
      argumentHint: 'login [endereco] | logout | status',
    })
    const version = await $.session.version().catch(() => null)
    await gov.record('session.start', {
      clientVersion: version?.version,
      surface: e.surface ?? 'headless',
      interactive: e.isInteractive,
    })
    $.clock.every(FLUSH_EVERY_MS, () => {
      void gov?.flush()
    })
    void gov.flush()
    return started
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'adaflow' }, async ($, e) => {
    if (!gov) return { text: 'adaflow-governance ainda nao terminou de carregar; tente de novo.' }
    const [first, second] = e.args.trim().split(/\s+/)
    const sub = first?.toLowerCase() ?? ''
    if (sub === 'login') return { text: await gov.login(second) }
    if (sub === 'logout') return { text: await gov.logout() }
    if (sub === 'status' || sub === '') {
      void gov.flush()
      return { text: await gov.status() }
    }
    return { text: USAGE }
  })

  // So metadados: modelo, duracao, motivo e tokens. Nunca `e.answer` nem o texto do prompt.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await gov?.record('turn.complete', {
      turnId: e.turnId,
      model: e.usage?.model ?? 'desconhecido',
      durationMs: e.durationMs,
      reason: e.reason,
      subagent: e.agentId !== undefined,
      inputTokens: e.usage?.input_tokens,
      outputTokens: e.usage?.output_tokens,
      cacheReadInputTokens: e.usage?.cache_read_input_tokens,
      cacheCreationInputTokens: e.usage?.cache_creation_input_tokens,
    })
    return result
  }).catch(($, e, next) => next(e))

  // Uma recusa vinda de baixo (adaflow-guard ou outro plugin) vira tool.denied. O motivo e a
  // entrada da ferramenta nao saem daqui: so o nome da ferramenta e os ids de regra do guard.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined) {
      const rules = guardRuleIds(result.deny)
      await gov?.record('tool.denied', {
        tool: String(e.tool),
        decision: 'deny',
        source: rules ? 'adaflow-guard' : 'outro',
        rules: rules ?? undefined,
      })
    }
    return result
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    await gov?.flush()
    return next(e)
  }).catch(($, e, next) => next(e))

  // Faixa acima do prompt enquanto o login espera a aprovacao: o codigo e o link clicavel.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const pending = await read($, login)
    if (pending === null || e.props.hasSurvey) return next(e)
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const href = pending.verificationUriComplete ?? pending.verificationUri
    return (
      <Box flexDirection="row" gap={1}>
        <Text>Adaflow: confirme o codigo</Text>
        <Text bold>{pending.userCode}</Text>
        <Text>em</Text>
        <Link href={href} label={pending.verificationUri} />
        <Button key="cancel" label="Cancelar" onPress={() => gov?.cancelLogin('Adaflow: login cancelado.')} />
      </Box>
    )
  })
}
