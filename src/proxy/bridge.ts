import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
// The low-level Server is the right API here, not deprecated-by-accident
// usage: the proxy forwards tools/list and tools/call verbatim without
// declaring schemas of its own, which McpServer's high-level API cannot do.
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { ExactEvmScheme } from "@x402/evm/exact/client"
import { wrapFetchWithPayment, x402Client } from "@x402/fetch"
import { privateKeyToAccount } from "viem/accounts"
import { moneyToMicros } from "../config.js"
import type { PaymentRequirements } from "@x402/core/types"

/**
 * The paying proxy: a local MCP server a standard client (Claude Code,
 * Claude Desktop, MCP Inspector) can spawn over stdio. It holds the wallet
 * and fronts the remote paid MCP server: tools/list is forwarded verbatim,
 * and a tools/call that draws a 402 upstream is paid transparently and
 * retried, so the standard client only ever sees ordinary tool results.
 *
 * Money discipline: the spend cap binds at the signing point. A payment
 * policy on the x402 client filters out any challenge the remaining budget
 * cannot cover and reserves the chosen amount synchronously in the same
 * tick, so concurrent tool calls cannot both slip under the cap and there
 * is no separate probe request (each tool executes upstream exactly once).
 * The cap is configuration, never derived from tool arguments, so a
 * prompt-injected tool call cannot raise it.
 */
export interface ProxyOptions {
  upstreamUrl: string
  evmPrivateKey: `0x${string}`
  /** Total the proxy may spend across its lifetime, e.g. "$0.01". */
  spendCapUsd: string
  fetchImpl?: typeof fetch
}

/** True when an upstream error is the unpaid 402 that survives after the
 * budget policy refused to sign a payment for it. */
function isPaymentRefused(error: unknown): boolean {
  const withCode = error as { code?: unknown; message?: unknown }
  if (withCode.code === 402) return true
  return (
    typeof withCode.message === "string" && withCode.message.includes("402")
  )
}

// eslint-disable-next-line @typescript-eslint/no-deprecated
export function createPayingProxy(options: ProxyOptions): Server {
  const { upstreamUrl, evmPrivateKey, spendCapUsd } = options
  const baseFetch = options.fetchImpl ?? fetch
  const capMicros = moneyToMicros(spendCapUsd)
  let spentMicros = 0n

  // Cap enforcement AND reservation live in this synchronous policy, which
  // the x402 client runs while selecting what to pay. No await separates the
  // check from the reservation, so overlapping calls serialize correctly. A
  // payment that later fails leaves its reservation in place: conservative
  // in the safe direction (the proxy can only underspend its cap).
  const budgetPolicy = (
    _x402Version: number,
    requirements: PaymentRequirements[],
  ): PaymentRequirements[] => {
    const affordable = requirements.filter((r) => {
      const amount = (r as { amount?: unknown }).amount
      return (
        typeof amount === "string" &&
        /^\d+$/.test(amount) &&
        spentMicros + BigInt(amount) <= capMicros
      )
    })
    const chosen = affordable[0] as { amount?: string } | undefined
    if (chosen?.amount) spentMicros += BigInt(chosen.amount)
    return affordable
  }

  const signer = privateKeyToAccount(evmPrivateKey)
  const paying = wrapFetchWithPayment(
    baseFetch,
    new x402Client()
      .register("eip155:*", new ExactEvmScheme(signer))
      .registerPolicy(budgetPolicy),
  )

  async function connectUpstream(fetchImpl: typeof fetch): Promise<Client> {
    const client = new Client({
      name: "x402-paying-proxy",
      version: "0.1.0",
    })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(upstreamUrl), {
        fetch: fetchImpl,
      }),
    )
    return client
  }

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server(
    { name: "x402-paying-proxy", version: "0.1.0" },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const upstream = await connectUpstream(baseFetch)
    try {
      return await upstream.listTools()
    } finally {
      await upstream.close()
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // Free tools never draw a 402, so the paying fetch is safe for every
    // call; a paid tool's first POST earns the 402 (the tool has not run
    // yet), then the wrapped fetch pays and retries: one execution total.
    const upstream = await connectUpstream(paying)
    try {
      return await upstream.callTool(request.params)
    } catch (error) {
      if (isPaymentRefused(error)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Refused before payment: paying this call would exceed the proxy's spend cap (spent ${spentMicros} of ${capMicros} micro-USD).`,
            },
          ],
        }
      }
      throw error
    } finally {
      await upstream.close()
    }
  })

  return server
}
