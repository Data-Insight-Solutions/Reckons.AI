/**
 * Vision analysis helpers — Claude API + Mistral OCR.
 *
 * Tiered approach:
 *  - Claude Haiku: fast/cheap semantic checks ($0.001/screenshot)
 *  - Claude Sonnet: balanced accuracy ($0.003/screenshot)
 *  - Claude Opus: highest accuracy, detailed analysis ($0.015/screenshot)
 *  - Mistral OCR: best-in-class document/screen OCR (pixtral-large-2501)
 *
 * Usage:
 *   const result = await analyzeScreenshot(buffer, PROMPTS.navBar);
 *   expect(result.navPresent).toBe(true);
 *   expect(result.layoutIssues).toHaveLength(0);
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Page } from '@playwright/test';

// ── Model tiers ──────────────────────────────────────────────────────────────

export type VisionTier = 'haiku' | 'sonnet' | 'opus';

const TIER_MODELS: Record<VisionTier, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

// Approximate cost per screenshot analysis (input image + output JSON)
export const TIER_COST: Record<VisionTier, number> = {
  haiku: 0.001,
  sonnet: 0.003,
  opus: 0.015,
};

function getTier(): VisionTier {
  const env = process.env.VISION_TIER as VisionTier | undefined;
  if (env && env in TIER_MODELS) return env;
  return 'haiku'; // default to cheapest
}

// ── Claude client ────────────────────────────────────────────────────────────

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: getAnthropicKey() });
  }
  return _client;
}

// ── Analysis types ───────────────────────────────────────────────────────────

export type NavBarAnalysis = {
  navPresent: boolean;
  activeItem: string | null;
  itemCount: number;
  layoutIssues: string[];
};

export type GraphAnalysis = {
  nodesVisible: boolean;
  nodeCount: number;
  edgesVisible: boolean;
  labelCount: number;
  layoutIssues: string[];
};

export type SnapPanelAnalysis = {
  panelVisible: boolean;
  corner: string | null;
  hasScrollContent: boolean;
  layoutIssues: string[];
};

export type PageAnalysis = {
  description: string;
  features: string[];
  layoutIssues: string[];
  contentVisible: boolean;
  hasBlankAreas: boolean;
  overlapIssues: string[];
};

export type OCRResult = {
  extractedText: string;
  confidence: number;
  regions: Array<{
    text: string;
    bbox?: { x: number; y: number; width: number; height: number };
  }>;
};

// ── Prompts ──────────────────────────────────────────────────────────────────

export const PROMPTS = {
  navBar: `You are analyzing a screenshot of a navigation bar component from a knowledge graph app called Reckons.AI. It has a dark theme.
Answer only in valid JSON with this exact shape:
{
  "navPresent": boolean,
  "activeItem": string|null,
  "itemCount": number,
  "layoutIssues": string[]
}`,

  graph2D: `You are analyzing a screenshot of a 2D force-directed knowledge graph on a dark background.
Answer only in valid JSON with this exact shape:
{
  "nodesVisible": boolean,
  "nodeCount": number,
  "edgesVisible": boolean,
  "labelCount": number,
  "layoutIssues": string[]
}`,

  snapPanel: `You are analyzing a screenshot of a floating snap panel component.
Answer only in valid JSON with this exact shape:
{
  "panelVisible": boolean,
  "corner": string|null,
  "hasScrollContent": boolean,
  "layoutIssues": string[]
}`,

  fullPage: `You are analyzing a screenshot of a page from Reckons.AI, a knowledge graph app with a dark theme.
Identify all visible UI features and any layout/rendering problems.
Answer only in valid JSON with this exact shape:
{
  "description": string,
  "features": string[],
  "layoutIssues": string[],
  "contentVisible": boolean,
  "hasBlankAreas": boolean,
  "overlapIssues": string[]
}`,
};

// ── Claude Vision analysis ───────────────────────────────────────────────────

export async function analyzeScreenshot<T>(
  buffer: Buffer,
  prompt: string,
  tier?: VisionTier,
): Promise<{ result: T; durationMs: number; cost: number; model: string }> {
  const selectedTier = tier ?? getTier();
  const model = TIER_MODELS[selectedTier];
  const cost = TIER_COST[selectedTier];
  const base64 = buffer.toString('base64');

  const start = Date.now();
  const response = await getClient().messages.create({
    model,
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: base64 },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });
  const durationMs = Date.now() - start;

  const text =
    response.content.find((b) => b.type === 'text')?.text ?? '{}';
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [
    null,
    text,
  ];
  const result = JSON.parse(match[1].trim()) as T;

  return { result, durationMs, cost, model };
}

export async function analyzePageScreenshot<T>(
  page: Page,
  prompt: string,
  tier?: VisionTier,
): Promise<T> {
  const buffer = await page.screenshot();
  const { result } = await analyzeScreenshot<T>(buffer, prompt, tier);
  return result;
}

// ── Mistral OCR ──────────────────────────────────────────────────────────────
// Uses the dedicated /v1/ocr endpoint with `mistral-ocr-latest` model.
// This is the same API used in src/lib/integrations/parsers/mistral-ocr.ts.

const MISTRAL_OCR_URL = 'https://api.mistral.ai/v1/ocr';
const MISTRAL_OCR_MODEL = 'mistral-ocr-latest';
const MISTRAL_OCR_COST = 0.002; // approximate per image

export async function analyzeOCR(
  buffer: Buffer,
): Promise<{ result: OCRResult; durationMs: number; cost: number } | null> {
  const apiKey = getMistralKey();
  if (!apiKey) return null;

  const base64 = buffer.toString('base64');
  const dataUri = `data:image/png;base64,${base64}`;
  const start = Date.now();

  try {
    const response = await fetch(MISTRAL_OCR_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MISTRAL_OCR_MODEL,
        document: { type: 'image_url', image_url: dataUri },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(`Mistral OCR ${response.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = (await response.json()) as {
      pages?: Array<{ markdown: string; index?: number }>;
    };

    // Concatenate all page markdown into one text block
    const markdown = (data.pages ?? [])
      .map((p) => p.markdown)
      .join('\n\n');

    const result: OCRResult = {
      extractedText: markdown,
      confidence: markdown.length > 10 ? 0.9 : 0.3,
      regions: (data.pages ?? []).map((p) => ({ text: p.markdown })),
    };

    return { result, durationMs: Date.now() - start, cost: MISTRAL_OCR_COST };
  } catch (e) {
    console.warn('Mistral OCR failed:', (e as Error).message);
    return null;
  }
}

// ── Utility: check if API keys are available ─────────────────────────────────

export function getAnthropicKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY || process.env.VITE_CLAUDE_API_KEY;
}

export function hasAnthropicKey(): boolean {
  return !!getAnthropicKey();
}

export function getMistralKey(): string | undefined {
  return process.env.MISTRAL_API_KEY || process.env.VITE_MISTRAL_API_KEY;
}

export function hasMistralKey(): boolean {
  return !!getMistralKey();
}

export function availableTiers(): string[] {
  const tiers: string[] = ['local']; // always available
  if (hasMistralKey()) tiers.push('mistral-ocr');
  if (hasAnthropicKey()) {
    tiers.push('claude-haiku', 'claude-sonnet', 'claude-opus');
  }
  return tiers;
}
