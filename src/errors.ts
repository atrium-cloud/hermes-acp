import { RequestError } from '@agentclientprotocol/sdk'

import { GatewayRpcError } from './gateway/GatewayClient.js'

/**
 * Frame a failed gateway call as an ACP error that names the subsystem and the
 * action. A gateway error response carries its code and data through for the
 * client to inspect; timeouts and transport loss arrive as plain Errors, which
 * the SDK would otherwise ship as a bare "Internal error" with the real text
 * buried in `data.details`.
 *
 * Nothing is recovered from here — the caller decides whether the failure ends
 * the request.
 */
// An unknown/unowned session id is a client-supplied bad parameter, so it maps
// to invalidParams instead of the default internalError; the gateway code still
// rides in `data`. Other gateway codes stay internalError deliberately — their
// discriminant is `data.gatewayCode`, which the ACP clients here already read.
const GATEWAY_CODE_UNKNOWN_SESSION = 4007

export function gatewayMethodError(gatewayMethod: string, error: unknown): RequestError {
  if (error instanceof GatewayRpcError) {
    const data = { gatewayCode: error.code, gatewayData: error.data }
    const message = `gateway method ${gatewayMethod} failed: ${error.message}`
    if (error.code === GATEWAY_CODE_UNKNOWN_SESSION) {
      return RequestError.invalidParams(data, message)
    }
    return RequestError.internalError(data, message)
  }
  // A plain Error here is transport-level — a timeout or a dead child — not a
  // gateway response. The `gatewayTransport` flag lets a client tell "the
  // backend died" from "the gateway refused the request" (which carries a
  // gatewayCode instead).
  const message = error instanceof Error ? error.message : String(error)
  return RequestError.internalError({ gatewayTransport: true }, `gateway method ${gatewayMethod} failed: ${message}`)
}
