import type { Meta, StoryObj } from '@storybook/svelte';
import Sheet from '$lib/components/Sheet.svelte';

const meta = {
  title: 'Shell/Sheet',
  component: Sheet,
  parameters: {
    layout: 'fullscreen',
    backgrounds: { default: 'dark' },
  },
  argTypes: {
    title: { control: 'text' },
    zIndex: { control: { type: 'number' } },
  },
} satisfies Meta<typeof Sheet>;

export default meta;
type Story = StoryObj<typeof meta>;

// Force open so the bottom-sheet chrome (grabber, title, close, safe-area) is
// visible for review. Best viewed in a mobile viewport preset.
export const Open: Story = {
  args: { open: true, title: 'Panel title' },
};
