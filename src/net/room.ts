import { MAX_PLAYERS, PROTOCOL, type Member, type Msg, type Pose } from './protocol.ts';
import { LocalTransport, NetError, PeerTransport, type Link, type LinkStats, type Transport } from './transport.ts';
import type { SharedMission } from '../missions/runtime/runner.ts';

// Rooms (#26). Every game is a room: solo is a room of one that nobody has
// the code for yet. Star topology: guests connect only to the host, which
// relays poses between them. The host leaving dissolves the room and each
// guest carries on alone where they stand. No host migration.

export type Role = 'solo' | 'host' | 'guest';

/** The pose without the bookkeeping Room adds. */
export type PoseBody = Omit<Pose, 's' | 't'>;

export interface RoomEvents {
  /** Joined someone's room: put yourself next to them (null: they haven't moved yet). */
  welcomed(at: Pose | null): void;
  joined(m: Member): void;
  renamed(m: Member): void;
  pose(id: number, pose: Pose): void;
  left(id: number): void;
  /** Guest: the host's shared mission. */
  mission(state: SharedMission): void;
  /** Host: a guest asks to start a shared mission. */
  missionRequest(id: string): void;
  /** Something worth telling the player ("Sam joined"). */
  toast(text: string): void;
  /** Role, code or members changed (for the panel). */
  changed(): void;
}

export interface MemberInfo extends Member {
  you: boolean;
  host: boolean;
  /** Poses received per second (game traffic health). */
  rate: number;
  /** Route and round trip of our own link to them (host ↔ guest only). */
  stats: LinkStats | null;
}

/** Poses per second. */
const SEND_RATE = 15;
/** A link that's said nothing (not even a heartbeat) for this long is gone, ms. */
const SILENCE = 20_000;
const HEARTBEAT = 1000;
/** A guest who loses the host unexpectedly tries to get back in this many times (after a phone was backgrounded, say). */
const REJOINS = [2000, 5000, 10_000];
/** No I, O, 0 or 1: codes get read out across a table. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface Peer {
  id: number;
  name: string;
  /** Host only: the guest's link. */
  link?: Link;
  heard: number;
  /** Poses this second, and the last whole second's count. */
  count: number;
  rate: number;
  stats: LinkStats | null;
}

export class Room {
  role: Role = 'solo';
  /** Our room's code when hosting, theirs as a guest. */
  code: string | null = null;
  /** Hosting is being set up or a join is in progress. */
  busy = false;
  /** Last problem, for the panel. */
  error = '';
  myId = 0;
  name: string;
  /** Smoke tests: talk over a BroadcastChannel instead of PeerJS. */
  local: boolean;

  private readonly map: string;
  private readonly turn: boolean;
  private readonly events: RoomEvents;
  private readonly localPose: () => PoseBody;
  private readonly members = new Map<number, Peer>();
  private transport: Transport | null = null;
  /** Guest: the link to the host. */
  private hostLink: Link | null = null;
  private hostHeard = 0;
  private nextId = 1;
  private seq = 0;
  private lastSent = -Infinity;
  private missionSeq = 0;
  /** Guest: the newest shared mission state heard. */
  private heardMission = 0;
  /** Bumped on every role change, so stale callbacks from an old transport do nothing. */
  private epoch = 0;
  /** Getting back into the same room after losing it: don't teleport to the host again. */
  private rejoining = false;

  constructor(opts: { map: string; name: string; local: boolean; turn: boolean; events: RoomEvents; localPose: () => PoseBody }) {
    this.map = opts.map;
    this.name = opts.name;
    this.local = opts.local;
    this.turn = opts.turn;
    this.events = opts.events;
    this.localPose = opts.localPose;
    setInterval(() => this.heartbeat(), HEARTBEAT);
    addEventListener('pagehide', () => this.leave(true));
  }

  /** Players in the room, us included. */
  get size(): number {
    return this.members.size + 1;
  }

  /** Start hosting (if we aren't in a room already) and return the code to share. */
  async host(): Promise<string> {
    if (this.role !== 'solo') return this.code!;
    if (this.busy) throw new NetError('network', 'busy');
    this.busy = true;
    this.error = '';
    this.changed();
    const epoch = ++this.epoch;
    try {
      for (let attempt = 0; ; attempt++) {
        const code = randomCode();
        const transport = this.newTransport();
        try {
          await transport.host(code, (link) => epoch === this.epoch && this.greet(link));
        } catch (e) {
          transport.close();
          if (e instanceof NetError && e.kind === 'taken' && attempt < 5) continue;
          throw e;
        }
        if (epoch !== this.epoch) {
          transport.close();
          throw new NetError('network', 'cancelled');
        }
        this.transport = transport;
        this.role = 'host';
        this.code = code;
        this.myId = 0;
        return code;
      }
    } catch (e) {
      this.error = describe(e);
      throw e;
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  /** Join a friend's room by its code. Leaves any room we're in first. */
  async join(code: string, rejoin = 0): Promise<void> {
    code = code.trim().toUpperCase();
    if (rejoin === 0) {
      this.leave();
      this.error = '';
    }
    this.busy = true;
    this.code = code;
    this.rejoining = rejoin > 0;
    this.changed();
    const epoch = ++this.epoch;
    const transport = this.newTransport();
    try {
      const link = await transport.join(code);
      if (epoch !== this.epoch) {
        transport.close();
        return;
      }
      this.transport = transport;
      this.hostLink = link;
      this.hostHeard = performance.now();
      link.onMessage = (msg) => epoch === this.epoch && this.fromHost(msg);
      link.onClose = () => epoch === this.epoch && this.lostHost();
      link.send({ k: 'hello', v: PROTOCOL, name: this.name, map: this.map });
      setTimeout(() => {
        if (epoch !== this.epoch || this.role === 'guest') return;
        this.leave();
        this.error = 'No answer from the host';
        this.changed();
      }, 10_000);
    } catch (e) {
      transport.close();
      if (epoch !== this.epoch) return;
      this.busy = false;
      if (rejoin > 0 && rejoin < REJOINS.length && !(e instanceof NetError && e.kind === 'not-found')) {
        setTimeout(() => epoch === this.epoch && this.join(code, rejoin + 1), REJOINS[rejoin]);
        return;
      }
      this.code = null;
      this.error = e instanceof NetError && e.kind === 'not-found' ? `No room ${code} (the host may have left)` : describe(e);
      if (rejoin > 0) this.events.toast(`Lost room ${code}: playing solo`);
      this.changed();
    }
  }

  /** Back to a room of one where we stand. `quiet`: the page is going away. */
  leave(quiet = false): void {
    if (this.role === 'host') for (const m of this.members.values()) m.link?.send({ k: 'leave', id: 0 });
    if (this.role === 'guest') this.hostLink?.send({ k: 'leave', id: this.myId });
    this.epoch++;
    this.transport?.close();
    this.transport = null;
    this.hostLink = null;
    for (const id of [...this.members.keys()]) this.drop(id, quiet);
    this.role = 'solo';
    this.code = null;
    this.myId = 0;
    this.busy = false;
    if (!quiet) this.changed();
  }

  rename(name: string): void {
    name = cleanName(name);
    if (!name || name === this.name) return;
    this.name = name;
    if (this.role === 'host') this.broadcast({ k: 'name', id: 0, name });
    else if (this.role === 'guest') this.hostLink?.send({ k: 'name', id: this.myId, name });
    this.changed();
  }

  /** Every frame: send our pose at SEND_RATE (game time), if anyone's listening. */
  tick(clock: number): void {
    if (this.members.size === 0 && this.role !== 'guest') return;
    if (clock - this.lastSent < 1 / SEND_RATE - 1e-6 && clock >= this.lastSent) return;
    this.lastSent = clock;
    const pose = this.stamp(clock);
    if (this.role === 'host') this.broadcast({ k: 'pose', id: 0, pose });
    else if (this.myId > 0) this.hostLink?.send({ k: 'pose', id: this.myId, pose });
  }

  /** Host: the shared mission, to every guest. */
  sendMission(st: SharedMission): void {
    if (this.role === 'host') this.broadcast({ k: 'mission', s: ++this.missionSeq, st });
  }

  /** Guest: ask the host to start a shared mission. */
  requestMission(id: string): void {
    if (this.role === 'guest') this.hostLink?.send({ k: 'mstart', id });
  }

  /** Who's here, us first, with link health for the panel. */
  list(): MemberInfo[] {
    const host = this.role === 'guest' ? 0 : this.myId;
    const me: MemberInfo = { id: this.myId, name: this.name, you: true, host: this.role !== 'guest', rate: 0, stats: null };
    return [me, ...[...this.members.values()].map((m) => ({ id: m.id, name: m.name, you: false, host: m.id === host, rate: m.rate, stats: m.stats }))];
  }

  // ---- Host side.

  /** A new guest: wait for their hello, then welcome them in. */
  private greet(link: Link): void {
    let id = 0;
    const heardAt = performance.now();
    const timer = setTimeout(() => !id && link.close(), 10_000);
    link.onMessage = (msg) => {
      if (id) return this.fromGuest(id, msg);
      if (msg.k !== 'hello') return;
      clearTimeout(timer);
      const no = msg.v !== PROTOCOL ? 'Different game version: everyone reload the page' : msg.map !== this.map ? 'They are on a different map' : this.size >= MAX_PLAYERS ? `Room is full (${MAX_PLAYERS} max)` : '';
      if (no) {
        link.send({ k: 'reject', why: no });
        setTimeout(() => link.close(), 500);
        return;
      }
      id = this.nextId++;
      const m: Peer = { id, name: cleanName(msg.name) || `Player ${id + 1}`, link, heard: heardAt, count: 0, rate: 0, stats: null };
      const members = [{ id: 0, name: this.name }, ...[...this.members.values()].map(({ id, name }) => ({ id, name }))];
      link.send({ k: 'welcome', id, members, at: this.stamp(this.lastSent > -Infinity ? this.lastSent : 0) });
      this.broadcast({ k: 'join', m: { id, name: m.name } });
      this.members.set(id, m);
      this.events.joined({ id, name: m.name });
      this.events.toast(`${m.name} joined`);
      this.changed();
    };
    link.onClose = () => id && this.members.get(id)?.link === link && this.drop(id);
  }

  private fromGuest(id: number, msg: Msg): void {
    const m = this.members.get(id);
    if (!m) return;
    m.heard = performance.now();
    if (msg.k === 'pose') {
      m.count++;
      // Never trust the id a guest puts on it.
      this.broadcast({ k: 'pose', id, pose: msg.pose }, id);
      this.events.pose(id, msg.pose);
    } else if (msg.k === 'name') {
      m.name = cleanName(msg.name) || m.name;
      this.broadcast({ k: 'name', id, name: m.name }, id);
      this.events.renamed({ id, name: m.name });
      this.changed();
    } else if (msg.k === 'mstart') this.events.missionRequest(msg.id);
    else if (msg.k === 'leave') this.drop(id);
  }

  private broadcast(msg: Msg, except = -1): void {
    for (const m of this.members.values()) if (m.id !== except) m.link?.send(msg);
  }

  // ---- Guest side.

  private fromHost(msg: Msg): void {
    this.hostHeard = performance.now();
    if (msg.k === 'welcome') {
      const rejoined = this.rejoining || this.role === 'guest';
      this.rejoining = false;
      this.role = 'guest';
      this.busy = false;
      this.myId = msg.id;
      this.heardMission = 0;
      for (const id of [...this.members.keys()]) this.drop(id, true);
      for (const m of msg.members) this.add(m);
      const host = msg.members.find((m) => m.id === 0)?.name ?? 'the host';
      if (rejoined) this.events.toast(`Back in ${host}'s room`);
      else {
        this.events.welcomed(msg.at);
        this.events.toast(`Joined ${host}'s room`);
      }
      this.changed();
    } else if (msg.k === 'reject') {
      this.error = msg.why;
      this.leave();
    } else if (msg.k === 'pose') {
      const m = this.members.get(msg.id);
      if (!m) return;
      m.count++;
      m.heard = this.hostHeard;
      this.events.pose(msg.id, msg.pose);
    } else if (msg.k === 'mission') {
      if (msg.s <= this.heardMission) return;
      this.heardMission = msg.s;
      this.events.mission(msg.st);
    } else if (msg.k === 'join') {
      this.add(msg.m);
      this.events.toast(`${msg.m.name} joined`);
      this.changed();
    } else if (msg.k === 'name') {
      const m = this.members.get(msg.id);
      if (!m) return;
      m.name = msg.name;
      this.events.renamed({ id: m.id, name: m.name });
      this.changed();
    } else if (msg.k === 'leave') {
      if (msg.id !== 0) return this.drop(msg.id);
      const host = this.members.get(0)?.name ?? 'The host';
      this.leave();
      this.events.toast(`${host} left: playing solo`);
    }
  }

  /** The link to the host closed without a goodbye: try to get back in a few times. */
  private lostHost(): void {
    const code = this.code;
    const name = this.members.get(0)?.name ?? 'the host';
    this.epoch++;
    this.transport?.close();
    this.transport = null;
    this.hostLink = null;
    for (const id of [...this.members.keys()]) this.drop(id, true);
    this.role = 'solo';
    this.myId = 0;
    this.changed();
    if (!code) return;
    this.events.toast(`Lost ${name}: reconnecting…`);
    setTimeout(() => this.role === 'solo' && !this.busy && this.join(code, 1), REJOINS[0]);
  }

  private add(m: Member): void {
    if (m.id === this.myId) return;
    this.members.set(m.id, { id: m.id, name: m.name, heard: performance.now(), count: 0, rate: 0, stats: null });
    this.events.joined(m);
  }

  // ---- Both.

  private drop(id: number, quiet = false): void {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    m.link?.close();
    if (this.role === 'host') this.broadcast({ k: 'leave', id });
    this.events.left(id);
    if (!quiet) {
      this.events.toast(`${m.name} left`);
      this.changed();
    }
  }

  private stamp(clock: number): Pose {
    return { ...this.localPose(), s: ++this.seq, t: Math.round(clock * 1000) / 1000 };
  }

  private heartbeat(): void {
    const now = performance.now();
    if (this.role === 'guest' && this.hostLink) {
      this.hostLink.send({ k: 'hb' });
      if (now - this.hostHeard > SILENCE) this.lostHost();
    }
    if (this.role === 'host') {
      for (const m of [...this.members.values()]) {
        m.link?.send({ k: 'hb' });
        if (now - m.heard > SILENCE) this.drop(m.id);
      }
    }
    for (const m of this.members.values()) {
      m.rate = m.count;
      m.count = 0;
    }
    // Route and round trip of our own links (guests see only the host's).
    const links: [Peer, Link][] = [];
    for (const m of this.members.values()) {
      const link = m.link ?? (m.id === 0 ? this.hostLink : null);
      if (link) links.push([m, link]);
    }
    for (const [m, link] of links) link.stats().then((s) => (m.stats = s), () => {});
  }

  private newTransport(): Transport {
    return this.local ? new LocalTransport() : new PeerTransport(this.turn);
  }

  private changed(): void {
    this.events.changed();
  }
}

function randomCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}

export function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 16);
}

function describe(e: unknown): string {
  if (e instanceof NetError) {
    if (e.kind === 'timeout') return 'Timed out: check your connection and try again';
    if (e.kind === 'network') return `Couldn't reach the matchmaking server (${e.message})`;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
