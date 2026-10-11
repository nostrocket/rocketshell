/** State shared between the router and the mounted composer modes. */
export interface AppContext {
  root: HTMLElement;
  /** Current shell identity, or an empty string when no valid key is available. */
  getPubkey(): string;
  /** Notify the active mode whenever the shell identity changes. */
  onIdentityChanged(listener: (pubkey: string) => void): () => void;
}
