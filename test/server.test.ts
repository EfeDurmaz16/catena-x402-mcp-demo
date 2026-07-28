/**
 * Core invariant: MCP discovery is free; invoking the paid tool is charged
 * over x402 at the HTTP layer, and an unpaid invocation never reaches the
 * tool handler or the settlement adapter.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ExactEvmScheme } from "@x402/evm/exact/client"
import { wrapFetchWithPayment, x402Client } from "@x402/fetch"
import { privateKeyToAccount } from "viem/accounts"
import { afterEach, describe, expect, it } from "vitest"
import { MCP_PATH, PAID_TOOL } from "../src/server/paid-mcp-server.js"
import { startTestServer, TEST_PRIVATE_KEY } from "./helpers.js"
import type { TestServer } from "./helpers.js"

let server: TestServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

async function connectClient(
  url: string,
  fetchImpl?: typeof fetch,
): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" })
  const transport = new StreamableHTTPClientTransport(
    new URL(`${url}${MCP_PATH}`),
    fetchImpl ? { fetch: fetchImpl } : undefined,
  )
  await client.connect(transport)
  return client
}

function payingFetch(): typeof fetch {
  const signer = privateKeyToAccount(TEST_PRIVATE_KEY)
  const client = new x402Client().register(
    "eip155:*",
    new ExactEvmScheme(signer),
  )
  return wrapFetchWithPayment(fetch, client)
}

describe("paid MCP server", () => {
  it("serves initialize, tools/list and free tools without any payment", async () => {
    server = await startTestServer()
    const client = await connectClient(server.url)
    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toContain(PAID_TOOL)
    expect(names).toContain("pricing")

    const pricing = await client.callTool({ name: "pricing", arguments: {} })
    expect(JSON.stringify(pricing.content)).toContain("paid tool")

    expect(server.facilitator.verifyCalls).toHaveLength(0)
    expect(server.facilitator.settleCalls).toHaveLength(0)
    await client.close()
  })

  it("rejects an unpaid paid-tool call with a 402 challenge before the tool runs", async () => {
    server = await startTestServer()
    const response = await fetch(`${server.url}${MCP_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: PAID_TOOL, arguments: { topic: "usdc" } },
      }),
    })
    expect(response.status).toBe(402)
    expect(response.headers.get("payment-required")).toBeTruthy()
    expect(server.facilitator.settleCalls).toHaveLength(0)
  })

  it("runs the paid tool and settles when the client pays the challenge", async () => {
    server = await startTestServer()
    const client = await connectClient(server.url, payingFetch())
    const result = await client.callTool({
      name: PAID_TOOL,
      arguments: { topic: "usdc" },
    })
    expect(JSON.stringify(result.content)).toContain("premium-market-signal")
    expect(server.facilitator.verifyCalls).toHaveLength(1)
    expect(server.facilitator.settleCalls).toHaveLength(1)
    await client.close()
  })

  it("keeps discovery free even after a paid call settled", async () => {
    server = await startTestServer()
    const client = await connectClient(server.url, payingFetch())
    await client.callTool({ name: PAID_TOOL, arguments: { topic: "usdc" } })
    const tools = await client.listTools()
    expect(tools.tools.length).toBeGreaterThan(0)
    // Still exactly one settlement: discovery after payment stayed free.
    expect(server.facilitator.settleCalls).toHaveLength(1)
    await client.close()
  })
})

describe("server hardening", () => {
  it("rejects JSON-RPC batch requests outright (fail closed)", async () => {
    server = await startTestServer()
    const response = await fetch(`${server.url}${MCP_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: PAID_TOOL, arguments: { topic: "smuggled" } },
        },
      ]),
    })
    expect(response.status).toBe(400)
    expect(server.facilitator.verifyCalls).toHaveLength(0)
    expect(server.facilitator.settleCalls).toHaveLength(0)
  })
})
