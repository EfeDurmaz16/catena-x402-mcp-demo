# Security

This demo is testnet only. It settles USDC on Base Sepolia through a public
x402 facilitator.

Never put a mainnet private key in `.env`. `BUYER_EVM_PRIVATE_KEY` is a
throwaway testnet key that the paying proxy signs with; anything it holds
should be worthless.

Report a vulnerability privately through GitHub Security Advisories on
https://github.com/EfeDurmaz16/catena-x402-mcp-demo. Please do not open a
public issue first.
