// See https://kit.svelte.dev/docs/types#app
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    interface PageState { graphPerspective?: 'statements' | 'sources'; }
    // interface Platform {}
  }

  /** Injected by vite.config.ts from package.json — the single source of the version. */
  const __APP_VERSION__: string;
}

export {};
