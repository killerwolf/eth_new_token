const Web3 = require('web3');
const abi = require('./abi/erc20.json');
require('dotenv').config();

// Connect to Ethereum network using WebSocket provider
const web3 = new Web3('wss://mainnet.infura.io/ws/v3/' + process.env.INFURA_PROJECT_ID);

// Get the web3.eth object
const eth = web3.eth;

const mode = process.argv[2];

const displayTokenDetails = async (contractAddress) => {
  try {
    const erc20Contract = new web3.eth.Contract(abi, contractAddress);
    const symbol = await erc20Contract.methods.symbol().call();
    const name = await erc20Contract.methods.name().call();

    console.log(`New ERC-20 token detected: ${name} (${symbol})`);
    console.log(`Contract address: ${contractAddress}`);
    console.log(`DexScreener: https://dexscreener.com/ethereum/${contractAddress}`);
    console.log(`EtherScan: https://etherscan.io/address/${contractAddress}`);
    console.log(`TokenSniffer: https://tokensniffer.com/token/eth/${contractAddress}`);
    console.log(`GeckoTerminal: https://www.geckoterminal.com/eth/pools/${contractAddress}`);
  } catch (error) {
    console.error(`Error checking ERC20 interface: ${error}`);
  }
};

if (mode === 'ContractCreated') {
  // Subscribe to ContractCreated event on the Ethereum network
  const filter = eth.subscribe('logs', {
    address: null,
    topics: [
      web3.utils.keccak256('ContractCreated(address)')
    ]
  });

  // Listen for new ContractCreated events
  filter.on('data', async (log) => {
console.log(log);
    const contractAddress = log.topics[1];
    
    const erc20Contract = new web3.eth.Contract(abi, contractAddress);
    try {
      const isErc20 = await erc20Contract.methods.totalSupply().call();
      await displayTokenDetails(contractAddress);
    } catch (error) {
      console.error(`Error checking ERC20 interface: ${error}`);
    }
  });

  // Handle errors
  filter.on('error', (error) => {
    console.error(`Filter error: ${error}`);
  });

  // Handle subscription end
  filter.on('end', () => {
    console.log('Filter subscription ended');
  });
} else if (mode === 'Transfer') {
  // Subscribe to Transfer event on the Ethereum network
  const filter = eth.subscribe('logs', {
    address: null,
    topics: [
      web3.utils.sha3('Transfer(address,address,uint256)'),
      '0x0000000000000000000000000000000000000000000000000000000000000000', // from null address
      null // to any address
    ]
  });

  // Listen for new Transfer events
  filter.on('data', async (log) => {
    try {
      if (log.topics.length !== 3) {
        return; // Ignore events that are not ERC-20 Transfer events
      }

      const decoded = web3.eth.abi.decodeLog(
        [{
          type: 'address',
          name: 'from',
          indexed: true
        },
        {
          type: 'address',
          name: 'to',
          indexed: true
        },
        {
          type: 'uint256',
          name: 'value',
          indexed: false
        }],
        log.data,
        log.topics.slice(1)
      );

      const from = decoded.from;
      const to = decoded.to;
      const value = decoded.value;

      if (value === '0') {
          return; // Ignore events with zero value
        }

      const contractAddress = log.address;
      const erc20Contract = new web3.eth.Contract(abi, contractAddress);
      try {
        const totalSupply = await erc20Contract.methods.totalSupply().call();
        if(value === totalSupply)
          await displayTokenDetails(contractAddress);
      } catch (error) {
        console.error(`Error checking ERC20 interface: ${error}`);
      }

    } catch (error) {
      console.error(`Error processing log: ${error}`);
    }
  });

  // Handle errors
  filter.on('error', (error) => {
    console.error(`Filter error: ${error}`);
  });

  // Handle subscription end
  filter.on('end', () => {
    console.log('Filter subscription ended');
  });
} else {
  console.error('Invalid mode. Please specify either "ContractCreated" or "Transfer."');
}
