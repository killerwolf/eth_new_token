# eth-new-token

Realtime scanner that flags **freshly minted ERC-20 tokens** on Ethereum mainnet, built with
TypeScript and [viem](https://viem.sh). It follows logs over WebSocket (push) or HTTP (polling) and prints
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

A probe that fails (flaky provider) is reported as `unknown`, never as a clean result.
These are heuristics: a clean report is **not** a safety guarantee, and a flag is not proof of a rug.

## Setup

```bash
npm install
cp .env.example .env   # then set ETH_RPC_URL
```

### Choosing a provider and transport

`ETH_RPC_URL` is the full endpoint of any **Ethereum mainnet** node (Infura, Alchemy, QuickNode,
your own). Swap providers by editing that one line. The URL scheme picks the transport:

| Scheme | Transport | When to use |
| --- | --- | --- |
| `wss://` / `ws://` | Push subscriptions | Lowest latency, recommended |
| `https://` / `http://` | Polling every ~6 s (`eth_newFilter`, falling back to `eth_getLogs`) | Environments where WebSockets are blocked (proxies, some CI/cloud sandboxes) |

The scanner watches **every** contract, so the provider must allow log queries without an address
filter. Observed on mainnet (2026-11-03):

| Provider / transport | Result |
| --- | --- |
| drpc.org free, HTTPS polling | Works. Detected and verified a real new token on-chain. It has no `eth_newFilter` on the free plan; viem falls back to per-block `eth_getLogs`. |
| publicnode.com, HTTPS | **Do not use.** `eth_getLogs` without an address is rejected, and its `eth_newFilter` returned far fewer logs than the chain produces (1 in 15 s, against roughly 25 per block seen on drpc), so detections would be silently missed. |
| Infura / Alchemy, WebSocket | Recommended, but not live-tested by the author. Check your plan's log limits. |

The URL usually contains your API key, so keep `.env` out of git (it is gitignored); it is never
printed in error messages. The previous variable name `ETH_WS_URL` is still accepted.

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

## Links in the report

| Link | Status |
| --- | --- |
| DeBank profile (holder) | Verified (page loads) |
| Etherscan `/address/<token>` | Standard path (could not load the page from the author's sandbox: Cloudflare challenge) |
| DexScreener `/ethereum/<token>` | Unverified (same Cloudflare challenge). Pair-addressed pages are the canonical form; the token address is resolved by DexScreener's search |
| TokenSniffer `/token/eth/<token>` | Unverified (same) |
| GeckoTerminal | Pages are addressed by **pool**, so the link is only shown once a Uniswap pool exists (`/eth/pools/<pool>`). A factory returns a pool address as soon as it is created, even with no liquidity, so the page can still be empty or not yet indexed |

## Troubleshooting

**`Subscription error: error event` then the process exits.** The WebSocket could not be opened.
Node 22+ ships a built-in WebSocket client that reports a failed handshake as an empty event, so the
scanner then asks the HTTPS twin of your endpoint what is wrong and prints the answer, e.g.
`401: invalid project id` (key invalid, revoked or restricted) or "the key is fine, the WebSocket is
refused" (wrong path, firewall/VPN, allowlist). Quick manual check of a key:

```bash
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
  "https://mainnet.infura.io/v3/<your-key>"
```

## Reliability and security notes

- A transient RPC failure never hides a token: reads are retried (0.5 s, 1.5 s, 3 s), and if the
  provider keeps failing the token is released so the next event retries it. Only a definitive
  answer (revert, undecodable data, still no code) marks a token as "seen".
- Token names and symbols are chosen by the deployer, so they are sanitised before display
  (control/bidi characters stripped, URL schemes defanged, 64-character cap) and escaped per
  medium (Discord markdown). Discord messages disable mentions and link previews.
- RPC URLs, webhook URLs and bot tokens are redacted from every log line, including the ones
  viem prints itself. The secret parts of your configuration (API key in the URL, webhook token,
  bot token) are also masked when a provider echoes them without a URL around them. Provider error
  reasons and network codes (`ENOTFOUND`, …) stay visible so a bad endpoint is diagnosable;
  they are flattened to one line and capped at 200 characters.
- If the provider connection cannot be re-established the process exits with code 1, so a
  supervisor (`Restart=on-failure`, Docker `restart: on-failure`) restarts it.

## Development

```bash
npm run typecheck
npm test
```

CI runs typecheck, tests and build on Node 20, 22 and 24. The test suite includes an integration test
that runs both the WebSocket and the HTTP-polling paths of viem against an in-process fake JSON-RPC
node (`test/helpers/fakeNode.ts`), so no network or API key is needed. It proves the client wiring,
not behaviour on the live network.

## Layout

```
src/
  index.ts      CLI entry: wires config, client, shutdown
  config.ts     argv/env validation
  watch.ts      viem event subscriptions (typed from the ABI)
  handlers.ts   pure detection logic, RPC injected → unit-tested
  erc20.ts      totalSupply / name / symbol reads (string + legacy bytes32), with retry
  errors.ts     error classification (transient / definitive) + URL-safe messages
  text.ts       sanitising of attacker-controlled labels
  safeConsole.ts  redacts URLs from third-party console output
  risk.ts       bytecode/owner/proxy/liquidity heuristics
  notify.ts     Discord + Telegram sinks
  report.ts     output formatting
  seen.ts       bounded de-duplication set
```

> Detection is a heuristic, not a safety check. A "new token" can be a scam — always verify
> before interacting with it.
