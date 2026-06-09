import type { Preview } from '@storybook/svelte';
import '../src/lib/styles/global.css';

/**
 * Global Storybook preview config.
 * Applies the Reckons.AI design system tokens to every story.
 *
 * The dark background matches the real app so screenshots used in
 * visual regression and AI analysis reflect the correct color palette.
 */

const preview: Preview = {
  parameters: {
    backgrounds: {
      // Use the app's actual background by default
      default: 'reckons-dark',
      values: [
        { name: 'reckons-dark', value: '#0a0f14' },
        { name: 'surface',      value: '#131a24' },
        { name: 'white',        value: '#ffffff' },
      ],
    },
    layout: 'centered',
    docs: {
      theme: undefined,
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
};

export default preview;
