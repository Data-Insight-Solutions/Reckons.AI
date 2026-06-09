import type { Meta, StoryObj } from '@storybook/svelte';
import SnapPanel from '$lib/components/SnapPanel.svelte';

const meta = {
  title: 'Shell/SnapPanel',
  component: SnapPanel,
  parameters: {
    layout: 'fullscreen',
    backgrounds: { default: 'dark' },
  },
  argTypes: {
    corner: {
      control: 'select',
      options: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
    },
    width: { control: { type: 'range', min: 180, max: 700, step: 10 } },
  },
} satisfies Meta<typeof SnapPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BottomRight: Story = {
  args: { corner: 'bottom-right', width: 320 },
};

export const TopLeft: Story = {
  args: { corner: 'top-left', width: 280 },
};

export const BottomLeft: Story = {
  args: { corner: 'bottom-left', width: 360 },
};
