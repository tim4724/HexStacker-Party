// Type declarations for AirConsoleAdapter (partyplug). Keep in sync with the JS.
// Drop-in replacement for PartyConnection that speaks the AirConsole SDK.

export = AirConsoleAdapter;

declare class AirConsoleAdapter {
  constructor(airconsole: any, options?: AirConsoleAdapter.Options);

  reconnectAttempt: number;

  connect(): void;
  /** No-op (the SDK owns room creation). */
  create(): void;
  /** No-op (the SDK owns joining). */
  join(): void;
  /** No-op (the SDK owns the connection/shard; nothing to pin). */
  pinInstance(): void;
  sendTo(to: number, data: any): void;
  broadcast(data: any): void;
  reconnectNow(): void;
  resetReconnectCount(): void;
  close(): void;

  /** The AirConsole master controller's peerIndex, for RoomFlow.masterProvider. */
  getMasterPeerIndex(): number | null;

  // Callbacks (same shape as PartyConnection; onError is a no-op).
  onOpen: (() => void) | null;
  onClose: ((attempt: number, maxAttempts: number, meta?: { replaced?: boolean }) => void) | null;
  onError: (() => void) | null;
  onMessage: ((from: number, data: any) => void) | null;
  onProtocol: ((type: string, msg: any) => void) | null;

  /**
   * Install a localStorage shim backed by AirConsole persistent data. The
   * allowlist of persisted keys is injected by the game (the kit bakes in none).
   */
  static installAirConsoleStorage(
    airconsole: any,
    opts?: { allowlist?: string[] }
  ): AirConsoleAdapter.StorageShim;

  /** Capture an onReady that fires before wiring; returns a replay function. */
  static captureEarlyReady(airconsole: any): () => void;
  /** Bake the build version into an element by id. */
  static injectVersionLabel(elementId: string): void;
}

declare namespace AirConsoleAdapter {
  interface Options {
    role?: 'display' | 'controller';
    /** Runs at the top of the SDK onReady, before 'created'/'joined' is synthesized. */
    onReady?: (code: number, ac: any) => void;
  }

  interface StorageShim {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    clear(): void;
    requestLoad(): void;
    onLoad(cb: () => void): void;
  }
}
