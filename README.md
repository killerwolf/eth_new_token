# ERC-20 New Token Detector

The ERC-20 Detector is a Node.js script that detects new ERC-20 tokens and provides links to various platforms for tracking the token's .

## Installation

1. Clone this repository
2. Install Node.js
3. Install dependencies with `npm install`

## Usage

1. Get an Infura API key from [https://infura.io/](https://infura.io/)
2. Set the `INFURA_PROJECT_ID` environment variable to your Infura API key
3. Run the script with `node new-erc20-eth.js`

## Contributing

Contributions are welcome! Please fork this repository and submit a pull request with your changes.

## Potential Enhancements

- Add support for detecting fully minted ERC-721 tokens
- Detecs when tokens becomes trade-able
- Improve error handling and logging
- Add command-line options for specifying the Ethereum network to listen on and the type of tokens to detect
- Improve performance by caching information about already detected tokens
