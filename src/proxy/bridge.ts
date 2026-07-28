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

export interface ProxyOptions {
  upstreamUrl: string
  evmPrivateKey: `0x${string}`
  /** Total the proxy may spend across its lifetime, e.g. "$0.01". */
  spendCapUsd: string
  /** Only challenges on this network are signed (e.g. "eip155:84532"). */
  network: `${string}:${string}`
  fetchImpl?: typeof fetch
}

/** True when @x402 refused to sign because every requirement was filtered
 * by our budget policy. Do NOT match HTTP 402 or the substring "x402":
 * post-payment 402s and scheme errors also contain those and are not
 * spend-cap refusals. */
function isBudgetRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  return (
    "message" in error &&
    typeof error.message === "string" &&
    error.message.includes("filtered out by policies")
  )
}

/**
 * The paying proxy: a local MCP server a standard client (Claude Code,
 * Claude Desktop, MCP Inspector) can spawn over stdio. It holds the wallet
 * and fronts the remote paid MCP server: tools/list is forwarded verbatim,
 * and a tools/call that draws a 402 upstream is paid transparently and
 * retried, so the standard client only ever sees ordinary tool results.
 *
 * Money discipline: the spend cap binds at the signing point (see the
 * budget policy below), and there is no separate probe request: each tool
 * executes upstream exactly once. The cap is configuration, never derived
 * from tool arguments, so a prompt-injected tool call cannot raise it.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated
export function createPayingProxy(options: ProxyOptions): Server {
  const { upstreamUrl, evmPrivateKey, spendCapUsd, network } = options
  const baseFetch = options.fetchImpl ?? fetch
  const capMicros = moneyToMicros(spendCapUsd)
  let spentMicros = 0n

  // The x402 client runs this synchronous policy while selecting what to
  // pay: challenges the remaining budget cannot cover are filtered out, and
  // the chosen amount is reserved in the same tick, so overlapping tool
  // calls cannot both slip under the cap. A payment that later fails leaves
  // its reservation in place: conservative in the only safe direction (the
  // proxy can underspend its cap, never overspend it).
  const budgetPolicy = (
    _x402Version: number,
    requirements: PaymentRequirements[],
  ): PaymentRequirements[] => {
    const affordable = requirements.filter((r) => {
      const amount = (r as { amount?: unknown }).amount
      const reqNetwork = (r as { network?: unknown }).network
      return (
        reqNetwork === network &&
        typeof amount === "string" &&
        /^\d+$/.test(amount) &&
        spentMicros + BigInt(amount) <= capMicros
      )
    })
    const chosen = affordable[0] as { amount?: string } | undefined
    if (chosen?.amount) spentMicros += BigInt(chosen.amount)
    // Return only the reserved entry so reserved == signed by construction,
    // not by relying on the client's default first-entry selector.
    return affordable.slice(0, 1)
  }

  const signer = privateKeyToAccount(evmPrivateKey)
  const paying = wrapFetchWithPayment(
    baseFetch,
    new x402Client()
      // Pin the scheme to the configured network; do not sign eip155:* wildcards.
      .register(network, new ExactEvmScheme(signer))
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
      if (isBudgetRefusal(error)) {
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
