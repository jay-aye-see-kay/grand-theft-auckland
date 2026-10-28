import type { Room } from './room.ts';

// The 👥 button and its panel: your room's code and a link to share, your
// name, who's here with how their connection is routed (direct or via a
// relay) and its round trip, and a box to type a friend's code. Plus toasts
// ("Sam joined"). P opens it on a keyboard.

const TOAST_TIME = 4000;

const ROUTE: Record<string, string> = { lan: 'same wifi', direct: 'direct', relay: 'relay', '?': '…' };

export class RoomPanel {
  private readonly room: Room;
  private readonly button: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly codeEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly joinInput: HTMLInputElement;
  private readonly shareBtn: HTMLButtonElement;
  private readonly copyBtn: HTMLButtonElement;
  private readonly leaveBtn: HTMLButtonElement;
  private readonly toastEl: HTMLElement;
  private toastTimer = 0;
  /** Called with the name whenever it's changed (to save it). */
  onRename: (name: string) => void = () => {};

  constructor(hud: HTMLElement, room: Room) {
    this.room = room;
    this.button = document.createElement('button');
    this.button.id = 'room-btn';
    this.button.setAttribute('aria-label', 'Players');
    this.button.textContent = '👥';
    hud.appendChild(this.button);

    this.toastEl = document.createElement('div');
    this.toastEl.id = 'toast';
    this.toastEl.className = 'hidden';
    hud.appendChild(this.toastEl);

    this.panel = document.createElement('div');
    this.panel.id = 'room-panel';
    this.panel.className = 'hidden';
    this.panel.innerHTML = `
      <button class="room-close" aria-label="Close">✕</button>
      <h2>Play with friends</h2>
      <div class="room-code"><span>Room</span> <b data-code>····</b></div>
      <div class="room-row">
        <button data-share>Share link</button>
        <button data-copy>Copy link</button>
      </div>
      <p class="room-status" data-status></p>
      <ul class="room-list" data-list></ul>
      <label class="room-row">Your name <input data-name maxlength="16" autocomplete="off" /></label>
      <form class="room-row" data-join>
        <input data-code-input maxlength="4" placeholder="CODE" autocomplete="off" autocapitalize="characters" />
        <button type="submit">Join friend</button>
      </form>
      <button class="room-leave hidden" data-leave>Leave room</button>`;
    hud.appendChild(this.panel);
    const q = <T extends HTMLElement>(s: string) => this.panel.querySelector(s) as T;
    this.codeEl = q('[data-code]');
    this.statusEl = q('[data-status]');
    this.listEl = q('[data-list]');
    this.nameInput = q('[data-name]');
    this.joinInput = q('[data-code-input]');
    this.shareBtn = q('[data-share]');
    this.copyBtn = q('[data-copy]');
    this.leaveBtn = q('[data-leave]');

    this.button.addEventListener('pointerup', () => this.toggle());
    q('.room-close').addEventListener('pointerup', () => this.toggle(false));
    this.shareBtn.addEventListener('click', () => this.share());
    this.copyBtn.addEventListener('click', () => this.copy());
    this.leaveBtn.addEventListener('click', () => room.leave());
    this.nameInput.addEventListener('change', () => {
      room.rename(this.nameInput.value);
      this.nameInput.value = room.name;
      this.onRename(room.name);
    });
    q('[data-join]').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = this.joinInput.value.trim().toUpperCase();
      if (code.length !== 4) return;
      this.joinInput.value = '';
      this.joinInput.blur();
      room.join(code);
    });
    addEventListener('keydown', (e) => {
      // Not typing, and the HUD is up (not the title screen).
      if (e.target instanceof HTMLInputElement || !this.button.offsetParent) return;
      if (e.code === 'KeyP') this.toggle();
      if (e.code === 'Escape') this.toggle(false);
    });
    // Game keys typed into the boxes shouldn't drive the car (input.ts listens on window).
    for (const input of [this.nameInput, this.joinInput]) input.addEventListener('keydown', (e) => e.stopPropagation());
    setInterval(() => this.isOpen && this.refresh(), 1000);
  }

  get isOpen(): boolean {
    return !this.panel.classList.contains('hidden');
  }

  toggle(open = !this.isOpen): void {
    this.panel.classList.toggle('hidden', !open);
    if (!open) return;
    this.nameInput.value = this.room.name;
    // Opening it is asking for a code: start hosting (a room of one until someone joins).
    if (this.room.role === 'solo' && !this.room.busy) this.room.host().catch(() => {});
    this.refresh();
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.add('hidden'), TOAST_TIME);
  }

  /** Redraw from the room's state (it calls this when anything changes). */
  refresh(): void {
    const r = this.room;
    this.button.dataset.count = r.size > 1 ? String(r.size) : '';
    if (!this.isOpen) return;
    this.codeEl.textContent = r.code ?? '····';
    const linkable = r.role !== 'solo' && !!r.code;
    this.shareBtn.disabled = this.copyBtn.disabled = !linkable;
    this.shareBtn.classList.toggle('hidden', !navigator.share);
    this.leaveBtn.classList.toggle('hidden', r.role !== 'guest');
    this.statusEl.textContent = r.error
      ? r.error
      : r.busy
        ? (r.role === 'solo' && r.code ? `Joining ${r.code}…` : 'Getting a room code…')
        : r.role === 'host'
          ? (r.size > 1 ? 'You are hosting. If you leave, the room ends.' : 'Send friends the link, or have them type the code.')
          : r.role === 'guest'
            ? 'In a friend\'s room.'
            : '';
    this.statusEl.classList.toggle('error', !!r.error);
    this.listEl.innerHTML = '';
    for (const m of r.list()) {
      const li = document.createElement('li');
      const bits = [m.you ? `${m.name} (you)` : m.name];
      if (m.host) bits.push('host');
      if (!m.you) {
        if (m.stats) bits.push(`${ROUTE[m.stats.route]}${m.stats.rttMs !== null ? ` · ${m.stats.rttMs} ms` : ''}`);
        bits.push(`${m.rate}/s`);
      }
      li.textContent = bits.join(' · ');
      this.listEl.appendChild(li);
    }
  }

  private link(): string {
    const url = new URL(location.href);
    const keep = ['map', 'turn', 'net'].filter((k) => url.searchParams.has(k)).map((k) => [k, url.searchParams.get(k)!]);
    url.search = '';
    url.hash = '';
    for (const [k, v] of keep) url.searchParams.set(k, v);
    url.searchParams.set('room', this.room.code ?? '');
    return url.toString();
  }

  private async share(): Promise<void> {
    try {
      await navigator.share({ title: 'Grand Theft Auckland', text: `Join my game: room ${this.room.code}`, url: this.link() });
    } catch {
      // cancelled
    }
  }

  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.link());
      this.toast('Link copied');
    } catch {
      this.toast(this.link());
    }
  }
}
