/**
 * The paying proxy is what a standard MCP client talks to: it must forward
 * discovery verbatim, pay for the paid tool transparently, and refuse calls
 * that would break its spend cap BEFORE any payment.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, describe, expect, it } from "vitest"
import { createPayingProxy } from "../src/proxy/bridge.js"
import { MCP_PATH, PAID_TOOL } from "../src/server/paid-mcp-server.js"
import { startTestServer, TEST_PRIVATE_KEY } from "./helpers.js"
import type { TestServer } from "./helpers.js"

let server: TestServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

async function connectThroughProxy(
  upstreamUrl: string,
  spendCapUsd = "$0.01",
): Promise<Client> {
  const proxy = createPayingProxy({
    upstreamUrl,
    evmPrivateKey: TEST_PRIVATE_KEY,
    spendCapUsd,
  })
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await proxy.connect(serverTransport)
  const client = new Client({ name: "standard-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

describe("paying proxy", () => {
  it("forwards tools/list without paying", async () => {
    server = await startTestServer()
    const client = await connectThroughProxy(`${server.url}${MCP_PATH}`)
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name)).toContain(PAID_TOOL)
    expect(server.facilitator.settleCalls).toHaveLength(0)
    await client.close()
  })

  it("calls a free tool without paying", async () => {
    server = await startTestServer()
    const client = await connectThroughProxy(`${server.url}${MCP_PATH}`)
    const result = await client.callTool({ name: "pricing", arguments: {} })
    expect(JSON.stringify(result.content)).toContain("paid tool")
    expect(server.facilitator.settleCalls).toHaveLength(0)
    await client.close()
  })

  it("pays for the paid tool transparently and returns its result", async () => {
    server = await startTestServer()
    const client = await connectThroughProxy(`${server.url}${MCP_PATH}`)
    const result = await client.callTool({
      name: PAID_TOOL,
      arguments: { topic: "usdc" },
    })
    expect(JSON.stringify(result.content)).toContain("premium-market-signal")
    expect(server.facilitator.settleCalls).toHaveLength(1)
    await client.close()
  })

  it("refuses a call past the spend cap before any payment", async () => {
    server = await startTestServer() // $0.001 per call
    const client = await connectThroughProxy(
      `${server.url}${MCP_PATH}`,
      "$0.001", // cap fits exactly one paid call
    )
    const first = await client.callTool({
      name: PAID_TOOL,
      arguments: { topic: "usdc" },
    })
    expect(first.isError).toBeFalsy()
    const second = await client.callTool({
      name: PAID_TOOL,
      arguments: { topic: "usdc" },
    })
    expect(second.isError).toBe(true)
    expect(JSON.stringify(second.content)).toContain("Refused before payment")
    // Exactly one settlement: the over-cap call never reached the payment leg.
    expect(server.facilitator.settleCalls).toHaveLength(1)
    await client.close()
  })
})
