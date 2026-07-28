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
    expect(JSON.stringify(second.content)).toContain("spend cap")
    // Exactly one settlement: the over-cap call never reached the payment leg.
    expect(server.facilitator.settleCalls).toHaveLength(1)
    await client.close()
  })
})

describe("proxy hardening", () => {
  it("executes a free tool exactly once upstream (no probe request)", async () => {
    server = await startTestServer()
    let pricingPosts = 0
    // The paying wrapper may call with (url, init) or a Request object.
    const countingFetch: typeof fetch = async (input, init) => {
      let method = init?.method
      let body = typeof init?.body === "string" ? init.body : ""
      if (input instanceof Request) {
        method = input.method
        body = await input
          .clone()
          .text()
          .catch(() => "")
      }
      if (method === "POST" && body.includes('"pricing"')) {
        pricingPosts += 1
      }
      return fetch(input, init)
    }
    const proxy = createPayingProxy({
      upstreamUrl: `${server.url}${MCP_PATH}`,
      evmPrivateKey: TEST_PRIVATE_KEY,
      spendCapUsd: "$0.01",
      fetchImpl: countingFetch,
    })
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    await proxy.connect(serverTransport)
    const client = new Client({ name: "standard-client", version: "0.0.0" })
    await client.connect(clientTransport)
    await client.callTool({ name: "pricing", arguments: {} })
    expect(pricingPosts).toBe(1)
    await client.close()
  })

  it("caps concurrent paid calls: only one of two settles under a one-call cap", async () => {
    server = await startTestServer() // $0.001 per call
    const client = await connectThroughProxy(
      `${server.url}${MCP_PATH}`,
      "$0.001", // budget for exactly one paid call
    )
    const [first, second] = await Promise.all([
      client.callTool({ name: PAID_TOOL, arguments: { topic: "a" } }),
      client.callTool({ name: PAID_TOOL, arguments: { topic: "b" } }),
    ])
    const errors = [first, second].filter((r) => r.isError === true)
    expect(errors).toHaveLength(1)
    expect(server.facilitator.settleCalls).toHaveLength(1)
    await client.close()
  })
})
