import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadConfig } from "../config.js"
import { createPayingProxy } from "./bridge.js"

try {
  process.loadEnvFile()
} catch {
  // no .env file; environment variables may be set directly
}

const config = loadConfig()
if (!config.BUYER_EVM_PRIVATE_KEY) {
  console.error(
    "BUYER_EVM_PRIVATE_KEY is required: the proxy signs x402 payments with it (see .env.example)",
  )
  process.exit(2)
}

const proxy = createPayingProxy({
  upstreamUrl: config.UPSTREAM_MCP_URL,
  evmPrivateKey: config.BUYER_EVM_PRIVATE_KEY,
  spendCapUsd: config.PROXY_SPEND_CAP_USD,
})

await proxy.connect(new StdioServerTransport())
console.error(
  `x402 paying proxy up: fronting ${config.UPSTREAM_MCP_URL} over stdio`,
)
