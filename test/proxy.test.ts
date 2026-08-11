/**
 * The paying proxy is what a standard MCP client talks to: it must forward
 * discovery verbatim, pay for the paid tool transparently, and refuse calls
 * that would break its spend cap BEFORE any payment.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, describe, expect, it } from "vitest"
import { createPayingProxy } from "../src/proxy/paying-proxy.js"
import { MCP_PATH, PAID_TOOL } from "../src/server/paid-mcp-server.js"
import { startTestServer, TEST_PAY_TO, TEST_PRIVATE_KEY } from "./helpers.js"
import type { TestServer } from "./helpers.js"

let server: TestServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

async function connectThroughProxy(
  upstreamUrl: string,
  spendCapUsd = "$0.01",
  fetchImpl?: typeof fetch,
): Promise<Client> {
  const proxy = createPayingProxy({
    upstreamUrl,
    evmPrivateKey: TEST_PRIVATE_KEY,
    spendCapUsd,
    network: "eip155:84532",
    ...(fetchImpl ? { fetchImpl } : {}),
  })
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await proxy.connect(serverTransport)
  const client = new Client({ name: "standard-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

/** Answers the paid tool's POST with a 402 whose challenge is off-policy:
 * one requirement on another chain, one in another token. Both are priced
 * inside the cap, so only the network and asset pins can refuse them. */
function offPolicyChallengeFetch(): typeof fetch {
  const requirement = {
    scheme: "exact",
    amount: "1000",
    payTo: TEST_PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
  }
  const challenge = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepts: [
        // Mainnet USDC: right token, wrong chain.
        {
          ...requirement,
          network: "eip155:1",
          asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        },
        // Right chain, some other token.
        {
          ...requirement,
          network: "eip155:84532",
          asset: "0x1111111111111111111111111111111111111111",
        },
      ],
    }),
  ).toString("base64")

  return async (input, init) => {
    const request = new Request(input, init)
    const body = await request
      .clone()
      .text()
      .catch(() => "")
    if (body.includes(`"${PAID_TOOL}"`)) {
      return new Response("{}", {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": challenge,
        },
      })
    }
    return fetch(request)
  }
}

describe("paying proxy", () => {
  it("keeps free surfaces free through the proxy", async () => {
    server = await startTestServer()
    const client = await connectThroughProxy(`${server.url}${MCP_PATH}`)
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name)).toContain(PAID_TOOL)

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
    server = await startTestServer("$0.001")
    const client = await connectThroughProxy(
      `${server.url}${MCP_PATH}`,
      "$0.001",
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
  it("posts a paid call twice (402 then paid retry) and settles once", async () => {
    server = await startTestServer()
    let paidPosts = 0
    const countingFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const body = await request
        .clone()
        .text()
        .catch(() => "")
      if (request.method === "POST" && body.includes(`"${PAID_TOOL}"`)) {
        paidPosts += 1
      }
      return fetch(request)
    }
    const client = await connectThroughProxy(
      `${server.url}${MCP_PATH}`,
      "$0.01",
      countingFetch,
    )
    const result = await client.callTool({
      name: PAID_TOOL,
      arguments: { topic: "usdc" },
    })
    expect(JSON.stringify(result.content)).toContain("premium-market-signal")
    // Two POSTs, one execution: the first draws the 402 before the tool runs,
    // the second carries payment. A third would mean a wasted price probe.
    expect(paidPosts).toBe(2)
    expect(server.facilitator.settleCalls).toHaveLength(1)
    await client.close()
  })

  it("refuses an off-policy challenge (wrong network, wrong asset) unsigned", async () => {
    server = await startTestServer()
    const client = await connectThroughProxy(
      `${server.url}${MCP_PATH}`,
      "$0.01",
      offPolicyChallengeFetch(),
    )
    const result = await client.callTool({
      name: PAID_TOOL,
      arguments: { topic: "usdc" },
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain("Refused before payment")
    // Nothing was signed, so the facilitator never saw a payload.
    expect(server.facilitator.verifyCalls).toHaveLength(0)
    expect(server.facilitator.settleCalls).toHaveLength(0)
    await client.close()
  })

  it("caps concurrent paid calls: only one of two settles under a one-call cap", async () => {
    server = await startTestServer("$0.001")
    const client = await connectThroughProxy(
      `${server.url}${MCP_PATH}`,
      "$0.001",
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
