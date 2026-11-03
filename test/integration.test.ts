import { afterEach, describe, expect, it } from 'vitest';
import { createPublicClient, encodeAbiParameters, getAddress, pad, webSocket, zeroAddress, type Address } from 'viem';
import { mainnet } from 'viem/chains';
import { readTokenInfo, readTotalSupply } from '../src/erc20.js';
import type { Deps } from '../src/handlers.js';
import type { ReportExtras, TokenInfo } from '../src/report.js';
import { readRisk } from '../src/risk.js';
import { SeenSet } from '../src/seen.js';
import { watchMints } from '../src/watch.js';
import { FakeNode, TRANSFER_TOPIC } from './helpers/fakeNode.js';

const TOKEN = '0x00000000000000000000000000000000000000aa' as Address;
const HOLDER = '0x00000000000000000000000000000000000000bb' as Address;
const SUPPLY = 1_000_000n * 10n ** 18n;

const topic = (address: Address) => pad(address, { size: 32 });
const amount = (value: bigint) => encodeAbiParameters([{ type: 'uint256' }], [value]);

let node: FakeNode | undefined;
let unwatch: (() => void) | undefined;

afterEach(async () => {
  unwatch?.();
  await node?.close();
});

describe('Transfer mode over a real WebSocket JSON-RPC connection', () => {
  it('announces a fresh mint (and ignores ERC-721-shaped Transfers)', async () => {
    node = new FakeNode([{ address: TOKEN, name: 'Pepe', symbol: 'PEPE', totalSupply: SUPPLY }]);
    const client = createPublicClient({
      chain: mainnet,
      transport: webSocket(node.url, { reconnect: false, keepAlive: false }),
    });

    const announced: Array<{ token: TokenInfo; extras: ReportExtras }> = [];
    const first = new Promise<void>((resolve) => {
      const deps: Deps = {
        readTotalSupply: (a) => readTotalSupply(client, a),
        readTokenInfo: (a) => readTokenInfo(client, a),
        readRisk: (a) => readRisk(client, a),
        announce: (token, extras) => {
          announced.push({ token, extras });
          resolve();
        },
        seen: new SeenSet(),
      };
      unwatch = watchMints(client, deps);
    });

    await node.subscribed();

    // ERC-721 mint: same topic0, but tokenId is a 4th indexed topic -> must be dropped by strict decoding.
    node.emitLog({
      address: TOKEN,
      topics: [TRANSFER_TOPIC, topic(zeroAddress), topic(HOLDER), pad('0x01', { size: 32 })],
      data: '0x',
    });
    // Real ERC-20 mint of the whole supply.
    node.emitLog({
      address: TOKEN,
      topics: [TRANSFER_TOPIC, topic(zeroAddress), topic(HOLDER)],
      data: amount(SUPPLY),
    });

    await Promise.race([
      first,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for announce')), 5000)),
    ]);

    expect(announced).toHaveLength(1);
    const [{ token, extras }] = announced as [(typeof announced)[number]];
    expect(token).toEqual({ address: getAddress(TOKEN), name: 'Pepe', symbol: 'PEPE' });
    expect(extras.holder).toBe(getAddress(HOLDER));
    expect(extras.risk).toMatchObject({
      decimals: 18,
      owner: { kind: 'none' },
      liquidity: { v2: false, v3Fees: [] },
    });
  });
});
