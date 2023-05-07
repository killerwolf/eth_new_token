const Web3 = require('web3');
const abi = require('./abi/erc20.json');

// Connect to Ethereum network using WebSocket provider
const web3 = new Web3('wss://mainnet.infura.io/ws/v3/' + process.env.INFURA_PROJECT_ID);

// Get the web3.eth object
const eth = web3.eth;

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
      // Ignore events that are not ERC-20 Transfer events
      return;
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
  
      
    const contract = new web3.eth.Contract(abi, log.address);
    const tokenName = await contract.methods.name().call()
    const tokenTotalSupply = await contract.methods.totalSupply().call()
    //console.log(`Transfer of ${await contract.methods.name().call()} from ${from} to ${to}: ${value} (Contract: https://etherscan.io/address/${log.address}) TotalSuply: ${await contract.methods.totalSupply().call()}`);

    if(value == tokenTotalSupply)
    {
        console.log(`
ERC-20 - ${tokenName} - ${tokenTotalSupply} : 
Holder: https://debank.com/profile/${to}
EtherScan: https://etherscan.io/address/${log.address}
GeckoTerminal: https://www.geckoterminal.com/eth/pools/${log.address}
TokenSniffer: https://tokensniffer.com/token/eth/${log.address}
`);
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
