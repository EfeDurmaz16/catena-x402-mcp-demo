# Demo script (3-5 min Loom)

Target: a tool call hitting a 402, being paid, and returning a result,
through a standard MCP client, per the acceptance criteria.

Prep (off camera): `.env` set (`SELLER_PAY_TO_ADDRESS`,
`BUYER_EVM_PRIVATE_KEY`), `pnpm install` done, Catena console open on the
account's transactions view in a background tab.

## Scene 1 - What this is (30s)

README diagram. Say:

> An MCP server whose paid tool is metered and charged over x402. The
> challenge lives at the HTTP layer of the transport, under the JSON-RPC
> framing, so the MCP protocol is untouched and any standard client works.
> A paying proxy holds the wallet; the client never sees x402.

## Scene 2 - The raw 402 (45s)

Terminal one:

```sh
pnpm server
```

Terminal two, an unpaid paid-tool call:

```sh
curl -si -X POST http://localhost:4040/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"premium_market_signal","arguments":{"topic":"usdc"}}}' | head -5
```

Point at `HTTP/1.1 402` and the `payment-required` header. Say: the tool
has not run; an unsettled call never reaches the handler.

## Scene 3 - Paid end to end (60s)

```sh
pnpm demo
```

Point at: `tools/list (free)`, then the paid call returning the
premium-market-signal JSON, then the PASS line. Say:

> Discovery is free. The paid call drew a 402, the proxy paid it against
> the live facilitator, the tool ran once, and the result came back as an
> ordinary MCP response.

## Scene 4 - A standard client (60s)

With `pnpm server` still running:

```sh
npx @modelcontextprotocol/inspector --cli npx tsx src/proxy/main.ts \
  --method tools/call --tool-name premium_market_signal --tool-arg topic=usdc
```

Say: MCP Inspector is a stock client that knows nothing about x402; the
proxy quoted, paid, and returned a plain tool result. Show the `.mcp.json`
snippet in the README for the Claude Code configuration.

## Scene 5 - Close (30s)

Catena console: the incoming $0.001 settlement. Closing line:

> The proxy's spend cap binds at the payment-signing point and is
> configuration, not tool arguments, so a prompt-injected tool call cannot
> raise it. Server rejects JSON-RPC batches outright so nothing can smuggle
> a paid call past the gate.
