import { createServer, type Server } from 'node:http';
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

type RpcOutcome = { result: unknown } | { error: { code: number; message: string; data?: string } };

export interface FakeToken {
  address: Address;
  name: string;
  symbol: string;
  totalSupply: bigint;
}

export interface FakeLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

const revert = (): RpcOutcome => ({
  error: { code: 3, message: 'execution reverted', data: '0x' },
});

/**
 * Minimal Ethereum JSON-RPC node serving the same methods over WebSocket (eth_subscribe push)
 * and HTTP (eth_newFilter / eth_getFilterChanges polling), so tests drive viem's real transports
 * offline. Not a live-network substitute: it only proves the client wiring.
 */
export class FakeNode {
  private readonly http: Server;
  private readonly ws: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();
  private subscription: { socket: WebSocket; id: string } | undefined;
  private pendingFilterLogs: unknown[] = [];
  private filterInstalled = false;
  private waiters: Array<() => void> = [];

  /** Start a node already listening on a free port. */
  static async start(tokens: FakeToken[]): Promise<FakeNode> {
    const node = new FakeNode(tokens);
    await new Promise<void>((resolve) => node.http.once('listening', resolve));
    return node;
  }

  private constructor(private readonly tokens: FakeToken[]) {
    this.http = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as RpcRequest | RpcRequest[];
        const answer = (request: RpcRequest) => ({
          jsonrpc: '2.0',
          id: request.id,
          ...this.dispatch(request.method, request.params ?? []),
        });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
      });
    });
    this.ws = new WebSocketServer({ server: this.http });
    this.ws.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('message', (raw) => {
        const request = JSON.parse(String(raw)) as RpcRequest;
        const outcome =
          request.method === 'eth_subscribe'
            ? this.subscribe(socket)
            : this.dispatch(request.method, request.params ?? []);
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...outcome }));
      });
    });
    this.http.listen(0, '127.0.0.1');
  }

  private get port(): number {
    const address = this.http.address();
    if (typeof address === 'string' || address === null) throw new Error('not listening');
    return address.port;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  get httpUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Resolves once a client has subscribed (WebSocket) or installed a filter (HTTP polling). */
  async subscribed(): Promise<void> {
    if (this.subscription || this.filterInstalled) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Make `log` visible to whichever client is connected: pushed over WS, or queued for polling. */
  emitLog(log: FakeLog): void {
    const full = {
      ...log,
      blockNumber: '0x1',
      blockHash: pad('0x01', { size: 32 }),
      transactionHash: pad('0x02', { size: 32 }),
      transactionIndex: '0x0',
      logIndex: '0x0',
      removed: false,
    };
    if (this.subscription) {
      this.subscription.socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_subscription',
          params: { subscription: this.subscription.id, result: full },
        }),
      );
    } else if (this.filterInstalled) {
      this.pendingFilterLogs.push(full);
    } else {
      throw new Error('no subscriber');
    }
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private subscribe(socket: WebSocket): RpcOutcome {
    this.subscription = { socket, id: '0xfeed' };
    this.release();
    return { result: '0xfeed' };
  }

  private release(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private dispatch(method: string, params: unknown[]): RpcOutcome {
    switch (method) {
      case 'eth_chainId':
        return { result: '0x1' };
      case 'eth_blockNumber':
        return { result: '0x1' };
      case 'eth_unsubscribe':
      case 'eth_uninstallFilter':
        return { result: true };
      case 'eth_newFilter':
        this.filterInstalled = true;
        this.release();
        return { result: '0xf11e' };
      case 'eth_getFilterChanges': {
        const logs = this.pendingFilterLogs;
        this.pendingFilterLogs = [];
        return { result: logs };
      }
      case 'eth_getCode':
        return { result: '0x6080604052' };
      case 'eth_getStorageAt':
        return { result: pad('0x', { size: 32 }) };
      case 'eth_call':
        return this.call(params[0] as { to: Address; data?: Hex; input?: Hex });
      default:
        return revert();
    }
  }

  private call({ to, data, input }: { to: Address; data?: Hex; input?: Hex }): RpcOutcome {
    const calldata = data ?? input ?? '0x';
    const token = this.tokens.find((t) => t.address.toLowerCase() === to.toLowerCase());
    // Not a known token => a factory (Uniswap getPair/getPool): answer "no pool".
    if (!token) return { result: pad('0x', { size: 32 }) };

    switch (calldata.slice(0, 10)) {
      case '0x18160ddd':
        return { result: encodeAbiParameters([{ type: 'uint256' }], [token.totalSupply]) };
      case '0x06fdde03':
        return { result: encodeAbiParameters([{ type: 'string' }], [token.name]) };
      case '0x95d89b41':
        return { result: encodeAbiParameters([{ type: 'string' }], [token.symbol]) };
      case '0x313ce567':
        return { result: numberToHex(18, { size: 32 }) };
      default:
        return revert();
    }
  }
}
