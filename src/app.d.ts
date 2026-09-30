// See https://kit.svelte.dev/docs/types#app
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // An extension point: SvelteKit merges this declaration into App.PageState, which only an
    // interface can do, so it stays one under the type-by-default rule (F204).
    interface PageState { graphPerspective?: 'statements' | 'sources'; }
    // interface Platform {}
  }

  /** Injected by vite.config.ts from package.json — the single source of the version. */
  const __APP_VERSION__: string;
}

export {};
