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

## Risk signals

Every detection is followed by on-chain, API-free heuristics so you know what to look at first:

- **Decimals / owner** — is `owner()` still an active address, renounced (`0x0` / `0xdEaD`), or absent?
- **Proxy** — EIP-1967 or EIP-1167 clone (the *implementation's* bytecode is then scanned).
- **Flags** — known selectors found in bytecode: `mintable`, `blacklist`, `pausable`, `tradingToggle`,
  `adjustableFees`, `txLimits`.
- **Liquidity** — whether a Uniswap V2 pair or V3 pool (0.05 / 0.3 / 1%) against WETH exists yet.

These are heuristics: a clean report is **not** a safety guarantee, and a flag is not proof of a rug.

## Setup

```bash
npm install
cp .env.example .env   # then set INFURA_PROJECT_ID
```

### Notifications (optional)

Set `DISCORD_WEBHOOK_URL` and/or `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in `.env` to also push
each detection there. Webhook URLs are validated and never written to logs. Delivery failures are
logged and never stop the scanner.

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

Decimals: 18
Owner: renounced
Proxy: no
Flags: none detected
Liquidity (vs WETH): none yet
```

## Development

```bash
npm run typecheck
npm test
```

CI runs typecheck, tests and build on Node 20 and 22. The test suite includes an integration test
that runs the real viem WebSocket subscription path against an in-process fake JSON-RPC node
(`test/helpers/fakeNode.ts`), so no network or API key is needed.

## Layout

```
src/
  index.ts      CLI entry: wires config, client, shutdown
  config.ts     argv/env validation
  watch.ts      viem event subscriptions (typed from the ABI)
  handlers.ts   pure detection logic, RPC injected → unit-tested
  erc20.ts      totalSupply / name / symbol reads (string + legacy bytes32)
  risk.ts       bytecode/owner/proxy/liquidity heuristics
  notify.ts     Discord + Telegram sinks
  report.ts     output formatting
  seen.ts       bounded de-duplication set
```

> Detection is a heuristic, not a safety check. A "new token" can be a scam — always verify
> before interacting with it.
