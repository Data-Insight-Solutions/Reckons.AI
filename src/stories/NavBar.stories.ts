import type { Meta, StoryObj } from '@storybook/svelte';
import { setMockPathname } from '../../.storybook/mocks/app-state';
import NavBar from '$lib/components/NavBar.svelte';

const meta = {
  title: 'Shell/NavBar',
  component: NavBar,
  parameters: {
    layout: 'fullscreen',
    backgrounds: { default: 'dark' },
  },
} satisfies Meta<typeof NavBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GraphActive: Story = {
  beforeEach() { setMockPathname('/'); },
};

export const IngestActive: Story = {
  beforeEach() { setMockPathname('/ingest'); },
};

export const ReviewActive: Story = {
  beforeEach() { setMockPathname('/review'); },
};

export const SettingsActive: Story = {
  beforeEach() { setMockPathname('/settings'); },
};
