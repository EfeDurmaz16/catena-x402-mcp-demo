import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadConfig } from "../config.js"
import { createPayingProxy } from "./paying-proxy.js"

const config = loadConfig()
if (!config.BUYER_EVM_PRIVATE_KEY) {
  console.error(
    "BUYER_EVM_PRIVATE_KEY is required: the proxy signs x402 payments with it (see .env.example)",
  )
  process.exit(2)
}

// Check the upstream before the client spawns us and waits on a handshake
// that cannot complete. /healthz is the cheapest proof the server is up.
try {
  const health = await fetch(new URL("/healthz", config.UPSTREAM_MCP_URL))
  if (!health.ok) {
    throw new Error(`healthz returned ${health.status}`)
  }
} catch {
  console.error(
    `Upstream MCP server unreachable at ${config.UPSTREAM_MCP_URL}; run 'pnpm server' first.`,
  )
  process.exit(1)
}

const proxy = createPayingProxy({
  upstreamUrl: config.UPSTREAM_MCP_URL,
  evmPrivateKey: config.BUYER_EVM_PRIVATE_KEY,
  spendCapUsd: config.PROXY_SPEND_CAP_USD,
  network: config.X402_NETWORK,
})

await proxy.connect(new StdioServerTransport())
// stderr on purpose: stdout is the JSON-RPC channel; console.log here
// corrupts every stdio session.
console.error(
  `x402 paying proxy up: fronting ${config.UPSTREAM_MCP_URL} over stdio`,
)
