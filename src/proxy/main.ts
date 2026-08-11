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
// that cannot complete. Only a connection-level failure is fatal: any HTTP
// response (even a 404 from an upstream without /healthz) proves something
// is listening, and a slow answer gets a warning, not a refusal, so the
// probe can never block a working setup.
try {
  await fetch(new URL("/healthz", config.UPSTREAM_MCP_URL), {
    signal: AbortSignal.timeout(3000),
  })
} catch (error) {
  if (error instanceof Error && error.name === "TimeoutError") {
    console.error(
      `Upstream at ${config.UPSTREAM_MCP_URL} did not answer /healthz within 3s; continuing anyway.`,
    )
  } else {
    console.error(
      `Upstream MCP server unreachable at ${config.UPSTREAM_MCP_URL}; run 'pnpm server' first.`,
    )
    process.exit(1)
  }
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
