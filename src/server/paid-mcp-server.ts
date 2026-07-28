import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { ExactEvmScheme } from "@x402/evm/exact/server"
import { paymentMiddleware, x402ResourceServer } from "@x402/express"
import express from "express"
import { z } from "zod"
import type { FacilitatorClient } from "@x402/core/server"
import type { Network } from "@x402/core/types"
import type { Express, RequestHandler } from "express"

export const MCP_PATH = "/mcp"
export const PAID_TOOL = "premium_market_signal"

export interface PaidMcpServerOptions {
  /** Address receiving tool-call payments (Catena sandbox deposit address). */
  payTo: string
  /** Price of one paid tool invocation, e.g. "$0.001". */
  price: string
  network: Network
  facilitatorClient: FacilitatorClient
}

/**
 * The x402 challenge/payment lives at the HTTP layer of the Streamable HTTP
 * transport, underneath MCP's JSON-RPC framing. Discovery stays free; only a
 * tools/call for the paid tool must carry a payment. This predicate decides
 * which requests the payment gate applies to.
 */
function isPaidToolCall(body: unknown): boolean {
  const message = body as
    { method?: unknown; params?: { name?: unknown } } | undefined
  return message?.method === "tools/call" && message.params?.name === PAID_TOOL
}

/** Fresh MCP server per request: the transport is stateless, so nothing is
 * shared between calls and a crashed request cannot poison the next one. */
function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "catena-x402-mcp-demo",
    version: "0.1.0",
  })
  server.registerTool(
    "pricing",
    {
      description:
        "Free: lists this server's tools and what a call to each costs.",
    },
    () => ({
      content: [
        {
          type: "text",
          text: `${PAID_TOOL} is a paid tool; invoking it requires an x402 USDC payment on Base Sepolia. This pricing tool is free.`,
        },
      ],
    }),
  )
  server.registerTool(
    PAID_TOOL,
    {
      description:
        "Paid: returns the premium market signal. Each invocation is metered and charged over x402 before the tool runs.",
      inputSchema: { topic: z.string().describe("Market to report on") },
    },
    ({ topic }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            report: "premium-market-signal",
            topic,
            signal: "accumulate",
            confidence: 0.87,
            issuedAt: new Date().toISOString(),
          }),
        },
      ],
    }),
  )
  return server
}

/**
 * Build the paid MCP server's Express app. Middleware order is the security
 * invariant: the payment gate runs before the MCP transport, so a paid
 * tools/call that has not settled never reaches the tool handler, while
 * initialize / tools/list / free tools pass through unpaid.
 */
export function createPaidMcpServer(options: PaidMcpServerOptions): Express {
  const { payTo, price, network, facilitatorClient } = options
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    network,
    new ExactEvmScheme(),
  )
  const payGate: RequestHandler = paymentMiddleware(
    {
      [`POST ${MCP_PATH}`]: {
        accepts: { scheme: "exact", network, payTo, price },
        description: `One invocation of the ${PAID_TOOL} MCP tool`,
      },
    },
    resourceServer,
  )

  const app = express()
  app.use(express.json())

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", paidTool: PAID_TOOL, price })
  })

  app.post(MCP_PATH, (req, res, next) => {
    if (isPaidToolCall(req.body)) {
      payGate(req, res, next)
      return
    }
    next()
  })

  app.post(MCP_PATH, (req, res, next) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    res.on("close", () => {
      void transport.close()
    })
    buildMcpServer()
      .connect(transport)
      .then(() => transport.handleRequest(req, res, req.body))
      .catch((error: unknown) => {
        next(error)
      })
  })

  return app
}
