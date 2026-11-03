import { WebSocketServer, type WebSocket } from 'ws';
import {
  encodeAbiParameters,
  keccak256,
  numberToHex,
  pad,
  toHex,
  type Address,
  type Hex,
} from 'viem';

export const TRANSFER_TOPIC = keccak256(toHex('Transfer(address,address,uint256)'));

interface RpcRequest {
  id: number;
  method: string;
  params?: unknown[];
}

export interface FakeToken {
  address: Address;
  name: string;
  symbol: string;
  totalSupply: bigint;
}

/**
 * Minimal Ethereum JSON-RPC node over WebSocket: just enough of eth_subscribe / eth_call /
 * eth_getCode for the scanner, so tests exercise viem's real subscription path offline.
 */
export class FakeNode {
  private readonly server: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();
  private subscription: { socket: WebSocket; id: string } | undefined;
  private waiter: (() => void) | undefined;

  constructor(private readonly tokens: FakeToken[]) {
    this.server = new WebSocketServer({ port: 0 });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('message', (raw) => this.handle(socket, JSON.parse(String(raw)) as RpcRequest));
    });
  }

  get url(): string {
    const address = this.server.address();
    if (typeof address === 'string' || address === null) throw new Error('not listening');
    return `ws://127.0.0.1:${address.port}`;
  }

  /** Resolves once a client has called eth_subscribe. */
  async subscribed(): Promise<void> {
    if (this.subscription) return;
    await new Promise<void>((resolve) => (this.waiter = resolve));
  }

  /** Push a log to the subscriber. `topics` decides ERC-20 (3) vs ERC-721 (4) shape. */
  emitLog(log: { address: Address; topics: Hex[]; data: Hex }): void {
    if (!this.subscription) throw new Error('no subscriber');
    this.subscription.socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_subscription',
        params: {
          subscription: this.subscription.id,
          result: {
            ...log,
            blockNumber: '0x1',
            blockHash: pad('0x01', { size: 32 }),
            transactionHash: pad('0x02', { size: 32 }),
            transactionIndex: '0x0',
            logIndex: '0x0',
            removed: false,
          },
        },
      }),
    );
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(socket: WebSocket, { id, method, params = [] }: RpcRequest): void {
    const reply = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
    const revert = () =>
      socket.send(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: '0x' } }),
      );

    switch (method) {
      case 'eth_subscribe':
        this.subscription = { socket, id: '0xfeed' };
        reply('0xfeed');
        this.waiter?.();
        return;
      case 'eth_unsubscribe':
        reply(true);
        return;
      case 'eth_getCode':
        reply('0x6080604052');
        return;
      case 'eth_getStorageAt':
        reply(pad('0x', { size: 32 }));
        return;
      case 'eth_call': {
        const { to, data } = params[0] as { to: Address; data?: Hex; input?: Hex };
        const input = (data ?? (params[0] as { input?: Hex }).input ?? '0x') as Hex;
        const token = this.tokens.find((t) => t.address.toLowerCase() === to.toLowerCase());
        if (!token) {
          // Factories (Uniswap getPair/getPool): "no pool".
          reply(pad('0x', { size: 32 }));
          return;
        }
        switch (input.slice(0, 10)) {
          case '0x18160ddd':
            return reply(encodeAbiParameters([{ type: 'uint256' }], [token.totalSupply]));
          case '0x06fdde03':
            return reply(encodeAbiParameters([{ type: 'string' }], [token.name]));
          case '0x95d89b41':
            return reply(encodeAbiParameters([{ type: 'string' }], [token.symbol]));
          case '0x313ce567':
            return reply(numberToHex(18, { size: 32 }));
          default:
            return revert();
        }
      }
      default:
        revert();
    }
  }
}
