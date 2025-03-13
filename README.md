# Ethereum Token Script

This script connects to the Ethereum network and listens for specific events related to ERC-20 tokens. It can operate in two modes: `ContractCreated` and `Transfer`.

## Modes

- **ContractCreated**: Subscribes to the `ContractCreated` event and checks if the new contract is an ERC-20 token. If so, it displays the token details.

- **Transfer**: Subscribes to the `Transfer` event, specifically looking for transfers from the null address. It checks if the transfer represents the total supply of the token and displays the token details if true.

## Usage

Run the script with the desired mode:

```bash
node script.js ContractCreated
```

Or:

```bash
node script.js Transfer
```

## Output

When a new ERC-20 token is detected, the script displays:

- Token name and symbol
- Contract address
- Links to useful tools for token analysis:
  - DexScreener
  - EtherScan
  - TokenSniffer
  - GeckoTerminal
- Holder address link (in Transfer mode)

## Requirements

- Node.js
- An Infura Project ID (set in .env file as INFURA_PROJECT_ID)
