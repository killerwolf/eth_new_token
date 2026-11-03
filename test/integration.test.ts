import { afterEach, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  http,
  pad,
  webSocket,
  zeroAddress,
  type Address,
  type Transport,
} from 'viem';
import { mainnet } from 'viem/chains';
import { readTokenInfo, readTotalSupply } from '../src/erc20.js';
import type { Deps } from '../src/handlers.js';
import type { ReportExtras, TokenInfo } from '../src/report.js';
import { readRisk } from '../src/risk.js';
import { SeenSet } from '../src/seen.js';
import { watchMints } from '../src/watch.js';
import { FakeNode, TRANSFER_TOPIC, type FakeToken } from './helpers/fakeNode.js';

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

/** Run Transfer mode against the fake node over the given transport and collect announcements. */
async function scanMints(
  makeTransport: (node: FakeNode) => Transport,
  token: Partial<FakeToken> = {},
) {
  node = await FakeNode.start([
    { address: TOKEN, name: 'Pepe', symbol: 'PEPE', totalSupply: SUPPLY, ...token },
  ]);
  const client = createPublicClient({
    chain: mainnet,
    transport: makeTransport(node),
    pollingInterval: 25,
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

  // ERC-721 mint: same topic0 but tokenId is a 4th indexed topic -> strict decoding must drop it.
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
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timed out waiting for announce')), 5000),
    ),
  ]);
  return announced;
}

/** Give a (buggy) duplicate announcement time to show up before asserting there is only one. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

async function expectFreshPepe(announced: Awaited<ReturnType<typeof scanMints>>) {
  await settle();
  expect(announced).toHaveLength(1);
  const [{ token, extras }] = announced as [(typeof announced)[number]];
  expect(token).toEqual({ address: getAddress(TOKEN), name: 'Pepe', symbol: 'PEPE' });
  expect(extras.holder).toBe(getAddress(HOLDER));
  expect(extras.risk).toMatchObject({
    decimals: 18,
    owner: { kind: 'none' },
    liquidity: { v2: false, v3Fees: [] },
  });
}

describe('Transfer mode against a local fake JSON-RPC node', () => {
  it('works over WebSocket (push subscription)', async () => {
    await expectFreshPepe(
      await scanMints((n) => webSocket(n.wsUrl, { reconnect: false, keepAlive: false })),
    );
  });

  it('works over HTTP (filter polling)', async () => {
    await expectFreshPepe(await scanMints((n) => http(n.httpUrl)));
  });

  it('announces legacy bytes32-metadata tokens (MKR-style) end to end', async () => {
    const announced = await scanMints((n) => http(n.httpUrl), {
      legacyBytes32: true,
      name: 'Maker',
      symbol: 'MKR',
    });
    expect(announced[0]?.token).toMatchObject({ name: 'Maker', symbol: 'MKR' });
  });

  it('resubscribes by itself after the provider drops the WebSocket', async () => {
    node = await FakeNode.start([{ address: TOKEN, name: 'Pepe', symbol: 'PEPE', totalSupply: SUPPLY }]);
    const client = createPublicClient({
      chain: mainnet,
      transport: webSocket(node.wsUrl, { reconnect: { attempts: 20, delay: 50 }, keepAlive: false }),
    });
    const announced: TokenInfo[] = [];
    unwatch = watchMints(client, {
      readTotalSupply: (a) => readTotalSupply(client, a),
      readTokenInfo: (a) => readTokenInfo(client, a),
      readRisk: async () => undefined,
      announce: (token) => announced.push(token),
      seen: new SeenSet(),
    });

    await node.subscribed();
    node.dropConnections();
    await Promise.race([
      node.subscribed(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('never resubscribed')), 5000)),
    ]);

    node.emitLog({
      address: TOKEN,
      topics: [TRANSFER_TOPIC, topic(zeroAddress), topic(HOLDER)],
      data: amount(SUPPLY),
    });
    for (let i = 0; i < 50 && announced.length === 0; i++) await settle();
    expect(announced).toHaveLength(1);
  });
});
