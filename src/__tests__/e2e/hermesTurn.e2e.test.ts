/**
 * Live-Hermes turn behavior: the cases that cannot be observed against a
 * scripted gateway because they depend on a real model, a real provider
 * endpoint, and real persisted history.
 *
 * Skipped unless RUN_HERMES_E2E=true (see e2eGate.ts); `bun run test:e2e`
 * builds first and sets it.
 */

import { rmSync } from 'node:fs'

import * as acp from '@agentclientprotocol/sdk'
import { afterEach, expect, it } from 'vitest'

import { CONFIG_OPTION_MODEL } from '../../constants.js'
import {
  describeE2E,
  E2E_BOOT_AND_TURN_TIMEOUT_MS,
  E2E_MODEL_VALUE_ID,
  E2E_SETUP_TIMEOUT_MS,
  E2E_SWITCH_MODEL_VALUE_ID,
  E2E_TURN_TIMEOUT_MS,
} from './e2eGate.js'
import type { SpawnedAgent } from './spawnedAgentFixture.js'
import { createScratchPaths, createSpawnedAgent } from './spawnedAgentFixture.js'

// ── Constants ───────────────────────────────────────────────────────────────

/** A marker the model can reproduce exactly, so the assertion is about the
 * turn arriving intact rather than about model prose. */
const ECHO_MARKER = 'hermes-e2e-ok'
const ECHO_PROMPT = `Reply with exactly ${ECHO_MARKER} and nothing else.`

/** Long enough that the cancel lands mid-turn rather than after it. */
const LONG_PROMPT = 'Count from 1 to 300, one number per line, with no other text.'

/** A model id no provider serves: upstream must refuse it loudly rather than
 * accept it and die as a silent end_turn next turn (hermes-agent#72439). */
const BOGUS_MODEL_VALUE_ID = 'openrouter/not-a-real-model-e2e'

const CANCEL_SETTLE_MS = 2_000

describeE2E('hermes live turns', () => {
  let fixture: SpawnedAgent | null = null
  /** Scratch this suite created itself (the two-process case); the fixture
   * only removes scratch it owns, so this is the other half. */
  let sharedScratchRoot: string | null = null

  afterEach(async () => {
    await fixture?.stop()
    fixture = null
    if (sharedScratchRoot !== null) {
      rmSync(sharedScratchRoot, { recursive: true, force: true })
      sharedScratchRoot = null
    }
  })

  /**
   * Open a session and pin the live model through the adapter's own
   * `session/set_config_option` — the headline feature, exercised as the way
   * the tier configures itself rather than by writing Hermes config behind the
   * adapter's back (codex-acp pins by writing backend config; this does not).
   */
  async function openPinnedSession(agent: SpawnedAgent): Promise<string> {
    const created = await agent.agent.request(acp.methods.agent.session.new, {
      cwd: agent.workspace,
      mcpServers: [],
    })
    await agent.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId: created.sessionId,
      configId: CONFIG_OPTION_MODEL,
      value: E2E_MODEL_VALUE_ID,
    })
    return created.sessionId
  }

  /**
   * A model value id on the same (authenticated) provider, other than the one
   * currently selected, read off the session's own advertised `configOptions`.
   * Fails loudly when the gateway offers only one model: a "switch" that stayed
   * put would report success without ever crossing the provider change the
   * case is about.
   */
  /** The pinned switch target, checked against what the session advertises so
   * a catalog that lacks it fails here rather than as a confusing turn error. */
  async function switchModelValueId(agent: SpawnedAgent, sessionId: string): Promise<string> {
    const modes = await agent.agent.request(acp.methods.agent.session.resume, {
      sessionId,
      cwd: agent.workspace,
      mcpServers: [],
    })
    const modelOption = modes.configOptions?.find((option) => option.id === CONFIG_OPTION_MODEL)
    if (modelOption === undefined || modelOption.type !== 'select') {
      throw new Error('e2e: the session advertised no model select to switch within')
    }
    const values = modelOption.options.flatMap((entry) =>
      'options' in entry ? entry.options.map((option) => option.value) : [entry.value],
    )
    if (!values.includes(E2E_SWITCH_MODEL_VALUE_ID)) {
      throw new Error(`e2e: this Hermes does not advertise the pinned switch target ${E2E_SWITCH_MODEL_VALUE_ID}`)
    }
    return E2E_SWITCH_MODEL_VALUE_ID
  }

  it(
    'streams a turn from the pinned model and ends it with end_turn',
    async () => {
      fixture = await createSpawnedAgent()
      const sessionId = await openPinnedSession(fixture)

      const response = await fixture.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: ECHO_PROMPT }],
      })

      expect(response.stopReason).toBe('end_turn')
      expect(fixture.agentText(sessionId)).toContain(ECHO_MARKER)
    },
    E2E_BOOT_AND_TURN_TIMEOUT_MS,
  )

  it(
    'reports a cancelled turn as cancelled, not as a clean end_turn',
    async () => {
      fixture = await createSpawnedAgent()
      const agent = fixture
      const sessionId = await openPinnedSession(agent)

      const pending = agent.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: LONG_PROMPT }],
      })
      // Attach the assertion up front: an early provider error would otherwise
      // reject with no handler and surface as an unhandled rejection rather
      // than a legible test failure.
      const cancelled = expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' })
      // Cancel only once the turn is actually streaming: a cancel that arrives
      // before the submit would test the staging path instead.
      await agent.waitForText(sessionId, (text) => text.length > 0, E2E_TURN_TIMEOUT_MS)
      await agent.agent.notify(acp.methods.agent.session.cancel, { sessionId })

      await cancelled
      // The gateway keeps the session usable after an interrupt.
      await new Promise((settle) => setTimeout(settle, CANCEL_SETTLE_MS))
      expect(agent.child.exitCode).toBeNull()
    },
    E2E_BOOT_AND_TURN_TIMEOUT_MS,
  )

  it(
    'refuses a bogus model id loudly instead of failing the next turn silently',
    async () => {
      // hermes-agent#72439: upstream accepted arbitrary model ids and the next
      // turn died as an end_turn with no output. The switch itself must fail.
      fixture = await createSpawnedAgent()
      const agent = fixture
      const created = await agent.agent.request(acp.methods.agent.session.new, {
        cwd: agent.workspace,
        mcpServers: [],
      })

      await expect(
        agent.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: created.sessionId,
          configId: CONFIG_OPTION_MODEL,
          value: BOGUS_MODEL_VALUE_ID,
        }),
      ).rejects.toThrow()
    },
    E2E_BOOT_AND_TURN_TIMEOUT_MS,
  )

  it(
    'runs a turn after a mid-session model switch, on the switched-to model',
    async () => {
      // hermes-agent#63222: a stale provider base_url after a switch misroutes
      // the following turn. The shape that exposes it is turn → switch → turn
      // on ONE session: the second turn has to cross the provider change.
      fixture = await createSpawnedAgent()
      const agent = fixture
      const sessionId = await openPinnedSession(agent)

      const first = await agent.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: ECHO_PROMPT }],
      })
      expect(first.stopReason).toBe('end_turn')

      // Switch to another model on the authenticated provider; a gateway with
      // a single such model has nothing to cross, so the case reports that
      // rather than pretending it tested a switch.
      const switched = await agent.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: CONFIG_OPTION_MODEL,
        value: await switchModelValueId(agent, sessionId),
      })
      const modelOption = switched.configOptions?.find((option) => option.id === CONFIG_OPTION_MODEL)
      expect(modelOption).toBeDefined()

      const textBeforeSecondTurn = agent.agentText(sessionId).length
      const second = await agent.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: ECHO_PROMPT }],
      })

      // The point of the case: the turn AFTER the switch really ran — it
      // streamed new text and ended cleanly, rather than dying at a stale
      // endpoint or coming back as an empty end_turn.
      expect(second.stopReason).toBe('end_turn')
      expect(agent.agentText(sessionId).length).toBeGreaterThan(textBeforeSecondTurn)
    },
    E2E_SETUP_TIMEOUT_MS + 2 * E2E_TURN_TIMEOUT_MS,
  )

  it(
    'replays real persisted history to a second adapter process',
    async () => {
      // The stored session lives in the Hermes home, so the reload has to be a
      // different adapter process against the SAME home — a load on the
      // process that created the session takes the already-tracked path and
      // proves nothing about persistence.
      const paths = createScratchPaths()
      sharedScratchRoot = paths.root
      const first = await createSpawnedAgent({ paths })
      let sessionId: string
      try {
        sessionId = await openPinnedSession(first)
        const response = await first.agent.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: ECHO_PROMPT }],
        })
        expect(response.stopReason).toBe('end_turn')
      } finally {
        await first.stop()
      }

      fixture = await createSpawnedAgent({ paths })
      await fixture.agent.request(acp.methods.agent.session.load, {
        sessionId,
        cwd: paths.workspace,
        mcpServers: [],
      })

      // The replay is synchronous and precedes the response, so the transcript
      // is already in hand: the first turn's prompt must be in it.
      const replayed = fixture.updates
        .filter((notification) => notification.sessionId === sessionId)
        .map((notification) => notification.update)
      expect(
        replayed.some(
          (update) =>
            update.sessionUpdate === 'user_message_chunk' &&
            update.content.type === 'text' &&
            update.content.text.includes(ECHO_MARKER),
        ),
      ).toBe(true)
    },
    // Two full agent boots against the same home, plus the turn the first one
    // runs before the second replays it.
    2 * E2E_SETUP_TIMEOUT_MS + E2E_TURN_TIMEOUT_MS,
  )
})
