# eth-new-token

Realtime scanner that flags **freshly minted ERC-20 tokens** on Ethereum mainnet, built with
TypeScript and [viem](https://viem.sh). It subscribes to logs over an Infura WebSocket and prints
the token plus links for quick vetting.

## Modes

| Mode | What it watches | Detection rule |
| --- | --- | --- |
| `ContractCreated` | `ContractCreated(address indexed)` emitted by token factories | The new contract answers `totalSupply()`, `name()` and `symbol()` |
| `Transfer` | `Transfer(0x0 → to, value)` mints | The first mint equals the token's entire `totalSupply()` |

Each token is announced once per run. ERC-721 `Transfer`s are filtered out by strict ABI decoding,
and non-token contracts are skipped silently.

## Setup

```bash
npm install
cp .env.example .env   # then set INFURA_PROJECT_ID
```

## Usage

```bash
npm start -- ContractCreated
npm start -- Transfer
```

Or build and run plain Node:

```bash
npm run build
npm run start:prod -- Transfer
```

Example output:

```
New ERC-20 token detected: Pepe (PEPE)
Contract address: 0x…
DexScreener: https://dexscreener.com/ethereum/0x…
EtherScan: https://etherscan.io/address/0x…
TokenSniffer: https://tokensniffer.com/token/eth/0x…
GeckoTerminal: https://www.geckoterminal.com/eth/pools/0x…
Holder: https://debank.com/profile/0x…      # Transfer mode only
```

## Development

```bash
npm run typecheck
npm test
```

CI runs typecheck, tests and build on Node 20 and 22.

## Layout

```
src/
  index.ts      CLI entry: wires config, client, shutdown
  config.ts     argv/env validation
  watch.ts      viem event subscriptions (typed from the ABI)
  handlers.ts   pure detection logic, RPC injected → unit-tested
  erc20.ts      totalSupply / name / symbol reads
  report.ts     output formatting
  seen.ts       bounded de-duplication set
```

> Detection is a heuristic, not a safety check. A "new token" can be a scam — always verify
> before interacting with it.
