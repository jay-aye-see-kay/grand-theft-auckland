import type { DataConnection, Peer as PeerType, PeerOptions } from 'peerjs';
import type { Msg } from './protocol.ts';

// How players reach each other. PeerJS (WebRTC data channels, introduced by
// PeerJS's free broker, relayed through its free TURN servers when a direct
// route fails) for real games; a BroadcastChannel between tabs of the same
// browser for smoke tests, which can't count on the public broker.

/** One player's line to another. The data channel is unordered: poses carry sequence numbers. */
export interface Link {
  send(msg: Msg): void;
  close(): void;
  onMessage: (msg: Msg) => void;
  onClose: () => void;
  /** How the connection is routed and its round trip, from WebRTC stats (null where there are none). */
  stats(): Promise<LinkStats | null>;
}

export interface LinkStats {
  /** 'lan' (same network), 'direct' (across the internet via STUN) or 'relay' (TURN). */
  route: 'lan' | 'direct' | 'relay' | '?';
  rttMs: number | null;
}

export interface Transport {
  /** Take `code` and accept guests on it. Rejects with NetError 'taken' if someone has it. */
  host(code: string, onGuest: (link: Link) => void): Promise<void>;
  /** Connect to the room `code`. Rejects with NetError 'not-found' if nobody hosts it. */
  join(code: string): Promise<Link>;
  close(): void;
}

export class NetError extends Error {
  readonly kind: 'taken' | 'not-found' | 'timeout' | 'network';
  constructor(kind: NetError['kind'], detail = '') {
    super(detail ? `${kind}: ${detail}` : kind);
    this.kind = kind;
  }
}

/** Room codes become PeerJS ids under this prefix (the broker is shared with every PeerJS app). */
const ID_PREFIX = 'gt-auckland-';
const JOIN_TIMEOUT = 20_000;
const STUN_ONLY: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

const noop = () => {};

export class PeerTransport implements Transport {
  /** ?turn=off: STUN only, to see which networks can't connect without a relay. */
  private readonly turn: boolean;
  private peer: PeerType | null = null;
  private readonly links = new Set<DataConnection>();
  private retry = 0;

  constructor(turn = true) {
    this.turn = turn;
  }

  async host(code: string, onGuest: (link: Link) => void): Promise<void> {
    const peer = await this.open(ID_PREFIX + code);
    peer.on('connection', (conn) => conn.once('open', () => onGuest(this.wrap(conn))));
    // Phones drop the broker's socket when backgrounded (sharing the link
    // from another app). Live links don't need it, but new guests do.
    peer.on('disconnected', () => this.reconnect(peer));
    addEventListener('visibilitychange', () => document.visibilityState === 'visible' && this.reconnect(peer));
  }

  async join(code: string): Promise<Link> {
    const peer = await this.open();
    const conn = peer.connect(ID_PREFIX + code, { reliable: false, serialization: 'json' });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new NetError('timeout')), JOIN_TIMEOUT);
      conn.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      peer.on('error', (e) => {
        clearTimeout(timer);
        reject(e.type === 'peer-unavailable' ? new NetError('not-found') : new NetError('network', e.type));
      });
    });
    return this.wrap(conn);
  }

  close(): void {
    for (const c of this.links) c.close();
    this.links.clear();
    this.peer?.destroy();
    this.peer = null;
  }

  private async open(id?: string): Promise<PeerType> {
    // Loaded on first use: solo players never fetch it.
    const { Peer } = await import('peerjs');
    const options: PeerOptions = { debug: 1 };
    if (!this.turn) options.config = { iceServers: STUN_ONLY };
    const peer = id ? new Peer(id, options) : new Peer(options);
    this.peer = peer;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new NetError('timeout', 'broker')), JOIN_TIMEOUT);
      peer.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      peer.once('error', (e) => {
        clearTimeout(timer);
        reject(e.type === 'unavailable-id' ? new NetError('taken') : new NetError('network', e.type));
      });
    });
    peer.on('error', (e) => console.warn('peer:', e.type, e.message));
    return peer;
  }

  private reconnect(peer: PeerType): void {
    if (peer.destroyed || !peer.disconnected || peer !== this.peer) return;
    const wait = Math.min(30_000, 1000 * 2 ** this.retry++);
    setTimeout(() => {
      if (peer.destroyed || !peer.disconnected) return;
      peer.reconnect();
      peer.once('open', () => (this.retry = 0));
    }, wait);
  }

  private wrap(conn: DataConnection): Link {
    this.links.add(conn);
    const link: Link = {
      send: (msg) => conn.open && void conn.send(msg),
      close: () => conn.close(),
      onMessage: noop,
      onClose: noop,
      stats: () => routeStats(conn.peerConnection),
    };
    conn.on('data', (d) => link.onMessage(d as Msg));
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.links.delete(conn);
      link.onClose();
    };
    conn.on('close', close);
    conn.on('error', close);
    return link;
  }
}

/** The selected candidate pair: which kind of route WebRTC settled on, and its round trip. */
async function routeStats(pc: RTCPeerConnection | undefined): Promise<LinkStats | null> {
  if (!pc) return null;
  const report = await pc.getStats();
  let pair: RTCIceCandidatePairStats | undefined;
  report.forEach((s) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId);
  });
  // Firefox marks the pair instead.
  if (!pair) report.forEach((s) => {
    if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) pair ??= s;
  });
  if (!pair) return { route: '?', rttMs: null };
  const local = report.get(pair.localCandidateId)?.candidateType;
  const remote = report.get(pair.remoteCandidateId)?.candidateType;
  const route = local === 'relay' || remote === 'relay' ? 'relay' : local === 'host' && remote === 'host' ? 'lan' : 'direct';
  const rtt = pair.currentRoundTripTime;
  return { route, rttMs: rtt === undefined ? null : Math.round(rtt * 1000) };
}

// ---- Smoke tests: tabs of one browser, over a BroadcastChannel.

interface Packet {
  kind: 'connect' | 'accept' | 'data' | 'close';
  from: string;
  to?: string;
  code?: string;
  msg?: Msg;
}

export class LocalTransport implements Transport {
  private readonly me = Math.random().toString(36).slice(2);
  private readonly channel = new BroadcastChannel('gt-auckland-net');
  private readonly links = new Map<string, Link>();
  private hosting: { code: string; onGuest: (link: Link) => void } | null = null;
  private waiting: ((from: string) => void) | null = null;

  constructor() {
    this.channel.onmessage = (e: MessageEvent<Packet>) => this.receive(e.data);
  }

  async host(code: string, onGuest: (link: Link) => void): Promise<void> {
    this.hosting = { code, onGuest };
  }

  async join(code: string): Promise<Link> {
    const from = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new NetError('not-found')), 1500);
      this.waiting = (f) => {
        clearTimeout(timer);
        resolve(f);
      };
      this.post({ kind: 'connect', from: this.me, code });
    });
    return this.link(from);
  }

  close(): void {
    for (const to of [...this.links.keys()]) this.post({ kind: 'close', from: this.me, to });
    this.links.clear();
    this.channel.close();
  }

  private receive(p: Packet): void {
    if (p.kind === 'connect') {
      if (!this.hosting || p.code !== this.hosting.code) return;
      this.post({ kind: 'accept', from: this.me, to: p.from });
      this.hosting.onGuest(this.link(p.from));
      return;
    }
    if (p.to !== this.me) return;
    if (p.kind === 'accept') this.waiting?.(p.from);
    else if (p.kind === 'data') this.links.get(p.from)?.onMessage(p.msg!);
    else if (p.kind === 'close') {
      const link = this.links.get(p.from);
      this.links.delete(p.from);
      link?.onClose();
    }
  }

  private link(to: string): Link {
    const link: Link = {
      send: (msg) => this.links.has(to) && this.post({ kind: 'data', from: this.me, to, msg }),
      close: () => {
        if (!this.links.delete(to)) return;
        this.post({ kind: 'close', from: this.me, to });
      },
      onMessage: noop,
      onClose: noop,
      stats: async () => null,
    };
    this.links.set(to, link);
    return link;
  }

  private post(p: Packet): void {
    this.channel.postMessage(p);
  }
}
