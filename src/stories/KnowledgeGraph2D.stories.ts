import type { Meta, StoryObj } from '@storybook/svelte';
import KnowledgeGraph2D from '$lib/3d/KnowledgeGraph2D.svelte';
import { SEED_STATEMENTS, SEED_SOURCES } from '../../.storybook/fixtures';

const meta = {
  title: 'Graph/KnowledgeGraph2D',
  component: KnowledgeGraph2D,
  parameters: {
    layout: 'fullscreen',
    backgrounds: { default: 'dark' },
  },
  argTypes: {
    layout: {
      control: 'select',
      options: ['force', 'focus', 'source', 'type', 'hub'],
    },
    dimMode: { control: 'boolean' },
  },
} satisfies Meta<typeof KnowledgeGraph2D>;

export default meta;
type Story = StoryObj<typeof meta>;

const confirmedStatements = SEED_STATEMENTS.filter(
  (s) => s.status === 'confirmed' || s.status === 'refined',
);

export const ForceLayout: Story = {
  args: {
    statements: confirmedStatements,
    sources: SEED_SOURCES,
    layout: 'force',
    selected: null,
    highlighted: [],
    dimMode: false,
  },
};

export const TypeLayout: Story = {
  args: {
    statements: confirmedStatements,
    sources: SEED_SOURCES,
    layout: 'type',
    selected: null,
    highlighted: [],
    dimMode: false,
  },
};

export const SourceLayout: Story = {
  args: {
    statements: confirmedStatements,
    sources: SEED_SOURCES,
    layout: 'source',
    selected: null,
    highlighted: [],
    dimMode: false,
  },
};

export const WithSelection: Story = {
  args: {
    statements: confirmedStatements,
    sources: SEED_SOURCES,
    layout: 'force',
    selected: 'i:urn:kb/Ada_Lovelace',
    highlighted: [],
    dimMode: false,
  },
};

export const WithDimMode: Story = {
  args: {
    statements: confirmedStatements,
    sources: SEED_SOURCES,
    layout: 'force',
    selected: 'i:urn:kb/Ada_Lovelace',
    highlighted: ['i:urn:kb/Ada_Lovelace', 'i:urn:kb/Analytical_Engine'],
    dimMode: true,
  },
};

export const HistoryMode: Story = {
  args: {
    statements: confirmedStatements,
    sources: SEED_SOURCES,
    layout: 'force',
    selected: null,
    highlighted: [],
    dimMode: false,
    historyTimestamp: Date.now() - 86_400_000,
  },
};

export const EmptyGraph: Story = {
  args: {
    statements: [],
    sources: [],
    layout: 'force',
    selected: null,
    highlighted: [],
    dimMode: false,
  },
};
