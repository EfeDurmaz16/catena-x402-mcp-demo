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

/**
 * The paying proxy: a local MCP server a standard client (Claude Code,
 * Claude Desktop, MCP Inspector) can spawn over stdio. It holds the wallet
 * and fronts the remote paid MCP server: tools/list is forwarded verbatim,
 * and a tools/call that draws a 402 upstream is paid transparently and
 * retried, so the standard client only ever sees ordinary tool results.
 *
 * Money discipline: before paying, the proxy quotes the price with an unpaid
 * probe and refuses the call when the running total would pass the spend
 * cap. The cap is configuration, never derived from tool arguments, so a
 * prompt-injected tool call cannot raise it.
 */
export interface ProxyOptions {
  upstreamUrl: string
  evmPrivateKey: `0x${string}`
  /** Total the proxy may spend across its lifetime, e.g. "$0.01". */
  spendCapUsd: string
  fetchImpl?: typeof fetch
}

interface ChallengeAccepts {
  accepts?: { scheme?: string; amount?: string }[]
}

// eslint-disable-next-line @typescript-eslint/no-deprecated
export function createPayingProxy(options: ProxyOptions): Server {
  const { upstreamUrl, evmPrivateKey, spendCapUsd } = options
  const baseFetch = options.fetchImpl ?? fetch
  const capMicros = moneyToMicros(spendCapUsd)
  let spentMicros = 0n

  const signer = privateKeyToAccount(evmPrivateKey)
  const paying = wrapFetchWithPayment(
    baseFetch,
    new x402Client().register("eip155:*", new ExactEvmScheme(signer)),
  )

  /** Unpaid probe of a tools/call: returns the quoted price in micro-dollars,
   * or 0n when the upstream serves it without a 402 (a free tool). */
  async function quoteMicros(request: unknown): Promise<bigint> {
    const response = await baseFetch(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(request),
    })
    if (response.status !== 402) return 0n
    const header = response.headers.get("payment-required")
    if (!header) {
      throw new Error("Upstream sent a 402 without an x402 challenge header")
    }
    const challenge = JSON.parse(
      Buffer.from(header, "base64").toString("utf8"),
    ) as ChallengeAccepts
    const amount = challenge.accepts?.find((a) => a.scheme === "exact")?.amount
    if (!amount || !/^\d+$/.test(amount)) {
      throw new Error("Upstream challenge carries no exact-scheme amount")
    }
    return BigInt(amount)
  }

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
    const price = await quoteMicros({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: request.params,
    })
    if (spentMicros + price > capMicros) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Refused before payment: this call costs ${price} micro-USD but the proxy has spent ${spentMicros} of its ${capMicros} micro-USD cap.`,
          },
        ],
      }
    }
    const upstream = await connectUpstream(price > 0n ? paying : baseFetch)
    try {
      const result = await upstream.callTool(request.params)
      // Only count the spend once the paid call actually succeeded.
      spentMicros += price
      return result
    } finally {
      await upstream.close()
    }
  })

  return server
}
