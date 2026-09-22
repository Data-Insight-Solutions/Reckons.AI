// See https://kit.svelte.dev/docs/types#app
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    interface PageState { graphPerspective?: 'statements' | 'sources'; }
    // interface Platform {}
  }
}

export {};
