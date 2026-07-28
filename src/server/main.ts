import { HTTPFacilitatorClient } from "@x402/core/server"
import { loadConfig } from "../config.js"
import { createPaidMcpServer, MCP_PATH } from "./paid-mcp-server.js"

try {
  process.loadEnvFile()
} catch {
  // no .env file; environment variables may be set directly
}

const config = loadConfig()
if (!config.SELLER_PAY_TO_ADDRESS) {
  console.error(
    "SELLER_PAY_TO_ADDRESS is required: tool payments settle to this address (your Catena sandbox deposit address).",
  )
  process.exit(2)
}

const app = createPaidMcpServer({
  payTo: config.SELLER_PAY_TO_ADDRESS,
  price: config.TOOL_PRICE_USD,
  network: config.X402_NETWORK,
  facilitatorClient: new HTTPFacilitatorClient({
    url: config.X402_FACILITATOR_URL,
  }),
})

const server = app.listen(config.MCP_PORT, () => {
  console.log(
    `Paid MCP server on http://localhost:${config.MCP_PORT}${MCP_PATH} (tool price ${config.TOOL_PRICE_USD}, pay-to ${config.SELLER_PAY_TO_ADDRESS ?? ""})`,
  )
})
// Fail loudly if the port is taken: a stale server with old config would
// otherwise serve the demo silently.
server.once("error", (error) => {
  console.error(error)
  process.exit(1)
})
