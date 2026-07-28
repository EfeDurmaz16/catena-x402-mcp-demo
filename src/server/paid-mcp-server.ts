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

/** The payment gate applies only to a tools/call for the paid tool;
 * discovery and free tools pass through unpaid. */
function isPaidToolCall(body: unknown): boolean {
  const message = body as
    { method?: unknown; params?: { name?: unknown } } | undefined
  return message?.method === "tools/call" && message.params?.name === PAID_TOOL
}

/** Fresh MCP server per request: the transport is stateless, so nothing is
 * shared between calls and a crashed request cannot poison the next one. */
function buildMcpServer(price: string): McpServer {
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
          text: `${PAID_TOOL} is a paid tool; each invocation costs ${price}, paid over x402 (USDC on Base Sepolia). This pricing tool is free.`,
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
    // JSON-RPC batching was removed from the MCP spec (2025-03-26 and
    // later), but the transport still tolerates arrays from legacy clients.
    // A batch could smuggle a paid tools/call past a single-message gate,
    // so fail closed on arrays instead of gating per element.
    if (Array.isArray(req.body)) {
      res.status(400).json({
        error: "batch_not_supported",
        message: "JSON-RPC batch requests are not supported",
      })
      return
    }
    if (isPaidToolCall(req.body)) {
      payGate(req, res, next)
      return
    }
    next()
  })

  app.post(MCP_PATH, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    res.on("close", () => {
      void transport.close()
    })
    await buildMcpServer(price).connect(transport)
    await transport.handleRequest(req, res, req.body)
  })

  return app
}
