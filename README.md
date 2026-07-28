# catena-x402-mcp-demo

An MCP server whose tool invocations are metered and charged over x402, plus
a reference client that pays per call. Work in progress: the paid server core
is functional and tested; the paying-proxy reference client is landing next.

## How it works

The x402 challenge lives at the HTTP layer of the MCP Streamable HTTP
transport, underneath the JSON-RPC framing, so the MCP protocol itself is
untouched. Discovery stays free; payment gates exactly one thing:

- `initialize`, `tools/list`, and the free `pricing` tool: no payment.
- `tools/call` on `premium_market_signal`: the server answers 402 with an
  x402 v2 challenge (exact scheme, Base Sepolia USDC). The client pays, the
  facilitator verifies and settles into the configured `payTo` (a Catena
  sandbox deposit address), and only then does the tool run.

Middleware order is the invariant: the payment gate sits in front of the MCP
transport, so an unsettled paid-tool call never reaches the tool handler.

## Run the paid server

```sh
pnpm install
cp .env.example .env   # set SELLER_PAY_TO_ADDRESS (Catena sandbox deposit address)
pnpm server
```

## Tests

`pnpm test` runs against an in-process server with a recording fake
facilitator; no network, no money. The suite proves discovery is free, an
unpaid call is refused with a 402 before the tool runs, and a paid call
settles exactly once.

## Scope

Consumes public surfaces only: the MCP TypeScript SDK (v1, protocol
2025-06-18), the public x402 packages and facilitator, and a Catena sandbox
account as the receiving side. No Catena SDK/CLI dependency in this server.
