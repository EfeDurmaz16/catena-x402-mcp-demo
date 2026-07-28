# Architecture

```
standard MCP client (Claude Code / Claude Desktop / MCP Inspector)
        | stdio (JSON-RPC)
  paying proxy  - holds the wallet; spend cap binds at the signing point
        | Streamable HTTP; 402 -> pay -> retry handled by wrapped fetch
  paid MCP server - x402 gate in FRONT of the MCP transport
        | facilitator verify / settle (x402.org)
  USDC on Base Sepolia -> Catena sandbox deposit address
```

## The invariant: payment before tool

The x402 challenge lives at the HTTP layer of the Streamable HTTP
transport, underneath MCP's JSON-RPC framing, so the MCP protocol is
untouched and standard clients stay compatible. Express middleware order is
the security boundary, exactly like the identity gate in
catena-x402-ack-id-demo: the payment gate runs before the MCP handler, so a
paid tools/call that has not settled never reaches the tool. Discovery
(`initialize`, `tools/list`) and free tools pass unpaid.

Two hardening choices worth knowing:

- **Batches fail closed.** The SDK's transport tolerates JSON-RPC batch
  arrays from legacy protocol revisions, and a batch could smuggle a paid
  tools/call past a single-message gate. The server rejects arrays with a
  400 instead of gating per element.
- **Per-request server instances.** The transport is stateless and each
  request gets a fresh McpServer, so no state leaks between paid calls.

## The proxy: how a standard client pays without knowing it

The reference client is a stdio MCP server the standard client spawns from
`.mcp.json`. It forwards `tools/list` verbatim and forwards `tools/call`
through a fetch wrapped with x402 payment. A paid tool's first POST earns
the 402 (the tool has not run), the wrapper pays and retries: one upstream
execution per call, no separate price probe.

The spend cap binds where signing happens: a payment policy on the x402
client filters out any challenge the remaining budget cannot cover and
reserves the chosen amount synchronously in the same tick. No await
separates check from reservation, so concurrent tool calls cannot both
slip under the cap. A payment that later fails leaves its reservation in
place - conservative in the only safe direction (the proxy can underspend
its cap, never overspend it). The cap is configuration; nothing derived
from tool arguments can raise it, so a prompt-injected tool call cannot
spend more.

Validated with a real standard client: MCP Inspector (CLI mode) listed the
tools and drove a paid call through the proxy against the live facilitator,
and the settlement appeared in the Catena ledger.

## SDK and spec versions

Pinned to `@modelcontextprotocol/sdk` v1 (1.30.x), which negotiates
protocol `2025-11-25`. The v2 SDK targets the 2026-07-28 spec revision
(stateless protocol, server discovery instead of the initialize handshake)
but is beta with a moving API; core APIs are functionally unchanged, so
migration is import-path-level when it stabilizes. The 2026-07-28 spec
added no payment primitive - HTTP-layer x402 under the transport remains
the compatible way to charge for tools.

## Why `exact`

Tool invocations are priced per call with the x402 `exact` scheme, the only
scheme in production. Usage-based settlement (`upto`) exists as a spec
draft without facilitator support; per-invocation flat pricing is also the
natural fit for MCP tools, where one call yields one result.

## Known limits

- **No identity gate.** ACK-ID verification before settlement is the
  composition point with catena-x402-ack-id-demo: its identity middleware
  mounts in front of the payment gate unchanged. Deliberately out of scope
  here to keep each demo single-purpose.
- **Per-call upstream connection.** The proxy opens a fresh MCP connection
  per forwarded call: simple and stateless, at the cost of a handshake per
  call. Fine for a demo; a long-lived upstream session is the obvious
  optimization.
- **Reservation is not released on failed payments.** By design (see
  above); restarting the proxy resets the meter, while the platform-side
  controls on the receiving account persist regardless.
