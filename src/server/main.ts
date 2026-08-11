import { HTTPFacilitatorClient } from "@x402/core/server"
import { loadConfig } from "../config.js"
import { createPaidMcpServer, MCP_PATH } from "./paid-mcp-server.js"

const config = loadConfig()
const payTo = config.SELLER_PAY_TO_ADDRESS
if (!payTo) {
  console.error(
    "SELLER_PAY_TO_ADDRESS is required: tool payments settle to this address (your Catena sandbox deposit address).",
  )
  process.exit(2)
}

// Reach the facilitator before announcing readiness: a server that prints
// its URL and answers /healthz while settlement is impossible is worse than
// one that refuses to start.
const facilitatorClient = new HTTPFacilitatorClient({
  url: config.X402_FACILITATOR_URL,
})
try {
  await facilitatorClient.getSupported()
} catch (error) {
  console.error(
    `Facilitator unreachable at ${config.X402_FACILITATOR_URL}; not starting.`,
    error,
  )
  process.exit(1)
}

const app = createPaidMcpServer({
  payTo,
  price: config.TOOL_PRICE_USD,
  network: config.X402_NETWORK,
  facilitatorClient,
})

const server = app.listen(config.MCP_PORT, () => {
  console.log(
    `Paid MCP server on http://localhost:${config.MCP_PORT}${MCP_PATH} (tool price ${config.TOOL_PRICE_USD}, pay-to ${payTo})`,
  )
})
// Fail loudly if the port is taken: a stale server with old config would
// otherwise serve the demo silently.
server.once("error", (error) => {
  console.error(error)
  process.exit(1)
})
