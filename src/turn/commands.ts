/**
 * Slash commands: the pure half.
 *
 * Two directions, both free of gateway and connection state:
 *   - `commands.catalog` → the `AvailableCommand` list advertised on
 *     `available_commands_update`, with the terminal-only entries excluded.
 *   - a `session/prompt` content list → the command invocation it encodes, if
 *     any, resolved against that catalog.
 *
 * Executing what comes back lives on HermesAcpServer, because it needs the
 * gateway and the session's update channel.
 */

import type { AvailableCommand, ContentBlock } from '@agentclientprotocol/sdk'

import {
  COMMAND_PREFIX,
  COMMAND_SUBCOMMAND_HINT_SEPARATOR,
  EXCLUDED_COMMANDS,
} from '../constants.js'
import type { CommandsCatalogResult } from '../gateway/types.js'

/**
 * What the adapter keeps from a `commands.catalog` snapshot: the commands the
 * client was told about, and the resolution table a prompt is matched against.
 */
export interface CommandCatalog {
  /** Exactly what was advertised, in catalog order. */
  readonly available: readonly AvailableCommand[]
  /** Lowercased `/name` (canonical names, aliases, and skill keys) → the
   * canonical `/name` to send to the gateway. */
  readonly resolution: ReadonlyMap<string, string>
}

export const EMPTY_COMMAND_CATALOG: CommandCatalog = { available: [], resolution: new Map() }

/**
 * Project a gateway catalog onto ACP.
 *
 * `pairs` is the listable set; `sub` is built over the whole upstream registry
 * and so is consulted only for commands that survived the exclusions. Aliases
 * are deliberately not advertised — upstream lists them in `canon` only, and
 * showing every alias as its own command would triple the list a client
 * renders — but they still resolve, which is why `resolution` is wider than
 * `available`.
 *
 * Skill commands appear in `pairs` and in `skills`, never in `canon`, so their
 * keys are added to the resolution table explicitly. Without that, every skill
 * invocation would fall through to the model as ordinary prompt text.
 */
export function buildCommandCatalog(catalog: CommandsCatalogResult): CommandCatalog {
  const subcommands = catalog.sub ?? {}
  const available: AvailableCommand[] = []
  const advertised = new Set<string>()

  for (const pair of catalog.pairs ?? []) {
    const [name, description] = pair
    if (EXCLUDED_COMMANDS.has(name) || advertised.has(name)) {
      continue
    }
    advertised.add(name)
    // ACP command names are bare: the client owns the "/" it renders.
    const command: AvailableCommand = { name: name.slice(COMMAND_PREFIX.length), description }
    const hint = subcommandHint(subcommands[name])
    available.push(hint === null ? command : { ...command, input: { hint } })
  }

  const resolution = new Map<string, string>()
  for (const [input, canonical] of Object.entries(catalog.canon ?? {})) {
    if (advertised.has(canonical)) {
      resolution.set(input.toLowerCase(), canonical)
    }
  }
  for (const key of Object.keys(catalog.skills ?? {})) {
    if (advertised.has(key)) {
      resolution.set(key.toLowerCase(), key)
    }
  }

  return { available, resolution }
}

/**
 * Subcommands as an input hint, or null when there are none.
 *
 * ACP models command input as one free-text `hint` string, so the subcommand
 * list is the honest thing to put there: it is what the user may type, not a
 * claim about structured arguments the adapter would have to parse.
 */
function subcommandHint(subcommands: readonly string[] | undefined): string | null {
  if (subcommands === undefined || subcommands.length === 0) {
    return null
  }
  return subcommands.join(COMMAND_SUBCOMMAND_HINT_SEPARATOR)
}

/** A recognized command invocation found in a prompt. */
export interface CommandInvocation {
  /** Canonical `/name` as the gateway knows it. */
  readonly canonicalName: string
  /** Everything after the name, trimmed. Empty when the command took none. */
  readonly argument: string
  /** The full `/name arg` line to hand to `slash.exec`. */
  readonly commandLine: string
}

/**
 * Recognize a command invocation in a prompt, or null for ordinary text.
 *
 * The grammar is codex-acp's verbatim (`CodexCommands.parseCommand`): only the
 * first content block counts and it must be text, the trimmed text must start
 * with "/", the first whitespace-delimited token is the name, and the rest is
 * one unstructured argument. ACP v1 has no dedicated command-invocation method,
 * so this convention is the only thing a client and agent share.
 *
 * An unrecognized `/word` returns null rather than an error: Hermes resolves
 * plenty of text that starts with a slash (paths, regexes) and the user may
 * simply have meant it literally.
 */
export function parseCommandInvocation(
  prompt: readonly ContentBlock[],
  catalog: CommandCatalog,
): CommandInvocation | null {
  const first = prompt[0]
  if (first === undefined || first.type !== 'text') {
    return null
  }
  const text = first.text.trim()
  if (!text.startsWith(COMMAND_PREFIX)) {
    return null
  }
  const body = text.slice(COMMAND_PREFIX.length).trim()
  const name = body.split(/\s+/)[0]
  if (name === undefined || name === '') {
    return null
  }

  const canonicalName = catalog.resolution.get(`${COMMAND_PREFIX}${name}`.toLowerCase())
  if (canonicalName === undefined) {
    return null
  }

  const argument = body.slice(name.length).trim()
  return {
    canonicalName,
    argument,
    commandLine: argument === '' ? canonicalName : `${canonicalName} ${argument}`,
  }
}
