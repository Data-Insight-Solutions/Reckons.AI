/**
 * Claude Vision helper for semantic visual QA.
 *
 * Instead of pixel-perfect comparison, we send a screenshot to Claude
 * and ask structured questions about what's visible. This is resilient
 * to font rendering differences, minor CSS tweaks, and anti-aliasing.
 *
 * Usage:
 *   const result = await analyzeScreenshot(screenshotBuffer, PROMPTS.navBar);
 *   expect(result.navPresent).toBe(true);
 *   expect(result.layoutIssues).toHaveLength(0);
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Page } from '@playwright/test';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

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

export const PROMPTS = {
  navBar: `You are analyzing a screenshot of a navigation bar component from a knowledge graph app.
Answer only in valid JSON with this exact shape:
{
  "navPresent": boolean,       // is a left-side vertical nav bar visible?
  "activeItem": string|null,   // label of the highlighted/active nav item, or null
  "itemCount": number,         // how many nav items are visible
  "layoutIssues": string[]     // list any layout problems (overlap, clipping, missing text)
}`,

  graph2D: `You are analyzing a screenshot of a 2D force-directed knowledge graph.
Answer only in valid JSON with this exact shape:
{
  "nodesVisible": boolean,     // are circular/shaped nodes visible on the canvas?
  "nodeCount": number,         // rough count of distinct nodes
  "edgesVisible": boolean,     // are lines/edges between nodes visible?
  "labelCount": number,        // how many node labels are readable
  "layoutIssues": string[]     // list any rendering problems (all nodes overlapping, blank canvas, etc.)
}`,

  snapPanel: `You are analyzing a screenshot of a floating snap panel component.
Answer only in valid JSON with this exact shape:
{
  "panelVisible": boolean,     // is a floating panel card visible?
  "corner": string|null,       // which screen corner is it anchored to? ("top-left","top-right","bottom-left","bottom-right")
  "hasScrollContent": boolean, // does it appear to have scrollable content inside?
  "layoutIssues": string[]     // list any layout problems (panel off-screen, missing drag handle, etc.)
}`,
};

/**
 * Take a screenshot of the current Playwright page and analyze it with Claude Vision.
 */
export async function analyzePageScreenshot<T>(
  page: Page,
  prompt: string,
  mask?: Parameters<Page['screenshot']>[0] extends { mask?: infer M } ? M : never,
): Promise<T> {
  const buffer = await page.screenshot({
    ...(mask ? { mask } : {}),
  });
  return analyzeScreenshot<T>(buffer, prompt);
}

/**
 * Analyze a raw screenshot buffer with Claude Vision.
 */
export async function analyzeScreenshot<T>(
  buffer: Buffer,
  prompt: string,
): Promise<T> {
  const base64 = buffer.toString('base64');

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: base64 },
          },
          {
            type: 'text',
            text: prompt,
          },
        ],
      },
    ],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '{}';
  // Extract JSON from response (model may wrap it in markdown code fences)
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? ([null, text] as [null, string]);
  return JSON.parse(match[1].trim()) as T;
}
