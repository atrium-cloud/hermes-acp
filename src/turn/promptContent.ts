/**
 * ACP prompt content blocks → one Hermes prompt.
 *
 * Hermes takes a single flat string plus whatever attachments were staged on
 * the session beforehand: `prompt.submit` has no attachment params, so images
 * are pushed onto the session's staged list by `image.attach_bytes` and drained
 * by the next submit (tui_gateway server.py `_run_prompt_submit`).
 * `file.attach` is the other half — it materializes the file in the session
 * workspace and hands back a `@file:` reference that only reaches the model if
 * the caller splices it into the prompt text.
 *
 * Everything that is not an image goes the `file.attach` route, PDFs included.
 * The gateway can rasterize a PDF into vision tiles (`pdf.attach`), but that
 * caps at 25 pages and needs poppler on the host; handed the file instead,
 * Hermes' own read tool extracts the text and its coverage warning steers the
 * agent to OCR the pages that need it, with no page cap.
 *
 * So this module both stages and assembles, in block order, and it is the one
 * place that knows the two are the same pass. If any staging call fails the
 * whole prompt fails and every image staged by this prompt is detached again:
 * a leftover would silently ride the next turn the user submits.
 */

import type { ContentBlock, EmbeddedResourceResource, ImageContent } from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'

import { gatewayMethodError } from '../errors.js'
import type { HermesGateway } from '../gateway/HermesGatewayClient.js'

// ── Constants ───────────────────────────────────────────────────────────────

/** Joiner for a multi-block prompt; Hermes takes one flat string. */
const PROMPT_BLOCK_SEPARATOR = '\n'

const IMAGE_MIME_PREFIX = 'image/'
/** MIME defaults for embedded resources that omit `mimeType` (it is optional
 * in the ACP schema), matching the two payload kinds it can carry. */
const DEFAULT_TEXT_MIME_TYPE = 'text/plain'
const DEFAULT_BLOB_MIME_TYPE = 'application/octet-stream'

/** Filename hints for payloads whose URI carries no usable basename. Upstream
 * sniffs image magic bytes regardless; these only steer the extension. */
const DEFAULT_IMAGE_BASENAME = 'image'
const DEFAULT_RESOURCE_NAME = 'resource'

const FILE_URI_PREFIX = 'file://'

// ── Assembly ────────────────────────────────────────────────────────────────

/** A prompt that has been staged on the gateway and is ready to submit. */
export interface StagedPrompt {
  /** The flat prompt text `prompt.submit` takes. */
  readonly text: string
  /**
   * Gateway-side paths of the images this prompt staged, in staging order.
   * They belong to the very next `prompt.submit` on this session, so a caller
   * that ends up not submitting must hand them to `detachStagedImages`.
   */
  readonly stagedImagePaths: readonly string[]
}

/**
 * Stage every attachment in `blocks` on the gateway session and assemble the
 * prompt text. Must be called immediately before `prompt.submit`: the staged
 * images belong to the next submit on this session.
 *
 * Staging that fails part-way rolls itself back. Staging that succeeds is the
 * caller's to roll back if the submit never happens.
 */
export async function stagePrompt(
  hermes: HermesGateway,
  sessionId: string,
  blocks: readonly ContentBlock[],
): Promise<StagedPrompt> {
  // Validate before touching the gateway so a prompt with an unsupported block
  // anywhere in it stages nothing at all.
  for (const block of blocks) {
    if (block.type === 'audio') {
      throw unsupportedBlockError(block.type)
    }
  }

  // Text contributed by each block, positionally. Image and PDF blocks
  // contribute nothing: their bytes ride the session's staged list, and the
  // reference client (apps/desktop use-prompt-actions/index.ts) likewise drops
  // the marker text those methods return.
  const segments: string[] = []
  // Gateway-side paths of everything this prompt staged, for rollback.
  const stagedImagePaths: string[] = []
  // Upstream's own composer markers, used only for the degenerate
  // attachment-without-text prompt (see the assembly below).
  const stagedMarkers: string[] = []

  try {
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          segments.push(block.text)
          break

        case 'image': {
          const result = await attach('image.attach_bytes', () =>
            hermes.imageAttachBytes({
              session_id: sessionId,
              content_base64: block.data,
              filename: imageFilename(block),
            }),
          )
          stagedImagePaths.push(result.path)
          stagedMarkers.push(result.text)
          break
        }

        case 'resource_link':
          // Mirrors codex-acp's formatUriAsLink (src/CodexAcpClient.ts): the
          // link is rendered into the prompt, never handed to the gateway as a
          // path — an ACP client's paths are its own and the gateway host
          // generally cannot see them.
          segments.push(formatUriAsLink(block.name, block.uri))
          break

        case 'resource':
          segments.push(await stageResource(hermes, sessionId, block.resource, stagedImagePaths, stagedMarkers))
          break

        case 'audio':
          // Unreachable: rejected by the pre-pass above.
          throw unsupportedBlockError(block.type)

        default:
          // Exhaustiveness guard: a new ContentBlock variant added to the SDK
          // fails the build here instead of being silently dropped from the prompt.
          block satisfies never
          throw unsupportedBlockError((block as ContentBlock).type)
      }
    }

    return { text: assembleText(segments, stagedMarkers), stagedImagePaths }
  } catch (error) {
    // Whatever went wrong, this prompt is not being submitted; its images must
    // not be waiting on the session when the next one is.
    await detachStagedImages(hermes, sessionId, stagedImagePaths)
    throw error
  }
}

function assembleText(segments: readonly string[], stagedMarkers: readonly string[]): string {
  const text = segments.filter((segment) => segment !== '').join(PROMPT_BLOCK_SEPARATOR)
  if (text !== '') {
    return text
  }
  if (stagedMarkers.length > 0) {
    // An attachment-only prompt. `prompt.submit` does accept empty text, but no
    // upstream client ever submits it that way — the desktop composer
    // substitutes a stand-in prompt instead (use-prompt-actions/submit.ts) — so
    // send upstream's own attachment markers rather than an untested empty turn.
    return stagedMarkers.join(PROMPT_BLOCK_SEPARATOR)
  }
  throw RequestError.invalidParams(undefined, 'ACP session/prompt: prompt carries no text')
}

/**
 * Stage one embedded resource and return the text it contributes. Images become
 * vision attachments; everything else — text, PDFs, arbitrary blobs — is
 * materialized as a workspace file whose `@file:` reference stands in for it in
 * the prompt.
 */
async function stageResource(
  hermes: HermesGateway,
  sessionId: string,
  resource: EmbeddedResourceResource,
  stagedImagePaths: string[],
  stagedMarkers: string[],
): Promise<string> {
  if ('text' in resource) {
    const result = await attach('file.attach', () =>
      hermes.fileAttach({
        session_id: sessionId,
        data_url: dataUrl(resource.mimeType ?? DEFAULT_TEXT_MIME_TYPE, base64OfText(resource.text)),
        name: resourceName(resource.uri),
      }),
    )
    return result.ref_text
  }

  if (resource.mimeType?.startsWith(IMAGE_MIME_PREFIX) === true) {
    const result = await attach('image.attach_bytes', () =>
      hermes.imageAttachBytes({
        session_id: sessionId,
        content_base64: resource.blob,
        filename: resourceName(resource.uri),
      }),
    )
    stagedImagePaths.push(result.path)
    stagedMarkers.push(result.text)
    return ''
  }

  const result = await attach('file.attach', () =>
    hermes.fileAttach({
      session_id: sessionId,
      data_url: dataUrl(resource.mimeType ?? DEFAULT_BLOB_MIME_TYPE, resource.blob),
      name: resourceName(resource.uri),
    }),
  )
  return result.ref_text
}

/** Run one staging call, naming the gateway method on failure. */
async function attach<Result>(gatewayMethod: string, call: () => Promise<Result>): Promise<Result> {
  try {
    return await call()
  } catch (error) {
    throw gatewayMethodError(gatewayMethod, error)
  }
}

/**
 * Roll back a prompt's staged images. Best-effort by necessity: the caller is
 * already failing the request and has no second channel to report on, so a
 * detach failure is logged and the original error still wins. `file.attach` has
 * no counterpart — a staged file stays in the workspace, but it never joins the
 * staged-image list, so it cannot leak into the next turn on its own.
 */
export async function detachStagedImages(
  hermes: HermesGateway,
  sessionId: string,
  paths: readonly string[],
): Promise<void> {
  for (const path of paths) {
    try {
      await hermes.imageDetach({ session_id: sessionId, path })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[hermes-agent-acp] gateway method image.detach failed: ${message}`)
    }
  }
}

// ── Rendering helpers ───────────────────────────────────────────────────────

function unsupportedBlockError(blockType: string): RequestError {
  return RequestError.invalidParams(
    undefined,
    `ACP session/prompt: content block type ${JSON.stringify(blockType)} is not supported by this adapter and no matching promptCapability is advertised`,
  )
}

/** codex-acp's `formatUriAsLink`, kept identical so both adapters render a
 * resource link the same way to the model. */
function formatUriAsLink(name: string | null | undefined, uri: string): string {
  if (name !== null && name !== undefined && name.length > 0) {
    return `[@${name}](${uri})`
  }
  if (uri.startsWith(FILE_URI_PREFIX)) {
    const path = uri.slice(FILE_URI_PREFIX.length)
    return `[@${path.split('/').pop() ?? path}](${uri})`
  }
  return uri
}

function imageFilename(block: ImageContent): string {
  const fromUri = basenameFromUri(block.uri)
  if (fromUri !== '') {
    return fromUri
  }
  if (!block.mimeType.startsWith(IMAGE_MIME_PREFIX)) {
    return DEFAULT_IMAGE_BASENAME
  }
  return `${DEFAULT_IMAGE_BASENAME}.${block.mimeType.slice(IMAGE_MIME_PREFIX.length)}`
}

function resourceName(uri: string): string {
  const basename = basenameFromUri(uri)
  return basename === '' ? DEFAULT_RESOURCE_NAME : basename
}

function basenameFromUri(uri: string | null | undefined): string {
  if (uri === null || uri === undefined) {
    return ''
  }
  const [withoutQuery = uri] = uri.split(/[?#]/)
  return withoutQuery.split('/').pop() ?? ''
}

function dataUrl(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`
}

function base64OfText(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}
