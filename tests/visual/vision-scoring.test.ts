import { describe, it, expect } from 'vitest';
import {
  scorePixelAnalysis,
  scoreDOMAnalysis,
  scoreTextAnalysis,
  buildMethodResult,
  buildComparisonTable,
  formatComparisonTable,
} from './vision-scoring';
import type { PixelAnalysis, DOMAnalysis, TextAnalysis } from './vision-local';
import type { VisualGolden, VisualBenchReport } from './vision-scoring';

const golden: VisualGolden = {
  noSolidFill: true,
  notBlank: true,
  mustBeVisible: ['nav', '.graph-pane'],
  mustNotOverlap: [['nav', '.graph-pane']],
  mustContainText: ['review', 'preview'],
  semanticFeatures: ['navigation bar'],
  description: 'test page',
};

describe('scorePixelAnalysis', () => {
  it('passes for normal screenshot', () => {
    const pixel: PixelAnalysis = {
      width: 1280, height: 720,
      dominantColor: '#0a0a10',
      dominantColorRatio: 0.3,
      averageBrightness: 20,
      uniqueColorCount: 500,
      isSolidFill: false,
      isBlank: false,
      hasColorAnomaly: false,
      anomalyDetails: [],
    };
    const checks = scorePixelAnalysis(pixel, golden);
    expect(checks.every(c => c.passed)).toBe(true);
  });

  it('fails for solid magenta fill', () => {
    const pixel: PixelAnalysis = {
      width: 1280, height: 720,
      dominantColor: '#e800f8',
      dominantColorRatio: 0.92,
      averageBrightness: 120,
      uniqueColorCount: 5,
      isSolidFill: true,
      isBlank: false,
      hasColorAnomaly: true,
      anomalyDetails: ['Solid magenta fill'],
    };
    const checks = scorePixelAnalysis(pixel, golden);
    expect(checks.some(c => !c.passed)).toBe(true);
    expect(checks.find(c => c.name === 'no-color-anomaly')?.passed).toBe(false);
  });

  it('fails for blank screen', () => {
    const pixel: PixelAnalysis = {
      width: 1280, height: 720,
      dominantColor: '#000000',
      dominantColorRatio: 0.99,
      averageBrightness: 1,
      uniqueColorCount: 3,
      isSolidFill: true,
      isBlank: true,
      hasColorAnomaly: false,
      anomalyDetails: ['Blank screen'],
    };
    const checks = scorePixelAnalysis(pixel, golden);
    expect(checks.find(c => c.name === 'not-blank')?.passed).toBe(false);
  });
});

describe('scoreDOMAnalysis', () => {
  it('passes when all elements visible and no overlaps', () => {
    const dom: DOMAnalysis = {
      visibleElements: [
        { selector: 'nav', visible: true, rect: { x: 0, y: 680, width: 1280, height: 40 } },
        { selector: '.graph-pane', visible: true, rect: { x: 0, y: 0, width: 900, height: 680 } },
      ],
      overlaps: [],
      offscreenElements: [],
      zIndexIssues: [],
    };
    const checks = scoreDOMAnalysis(dom, golden);
    expect(checks.every(c => c.passed)).toBe(true);
  });

  it('fails when required element is hidden', () => {
    const dom: DOMAnalysis = {
      visibleElements: [
        { selector: 'nav', visible: true, rect: { x: 0, y: 680, width: 1280, height: 40 } },
        { selector: '.graph-pane', visible: false, rect: null },
      ],
      overlaps: [],
      offscreenElements: [],
      zIndexIssues: [],
    };
    const checks = scoreDOMAnalysis(dom, golden);
    expect(checks.find(c => c.name === 'visible:.graph-pane')?.passed).toBe(false);
  });

  it('fails when forbidden overlap exists', () => {
    const dom: DOMAnalysis = {
      visibleElements: [
        { selector: 'nav', visible: true, rect: { x: 0, y: 600, width: 1280, height: 120 } },
        { selector: '.graph-pane', visible: true, rect: { x: 0, y: 0, width: 1280, height: 700 } },
      ],
      overlaps: [{
        element1: 'nav', element2: '.graph-pane',
        rect1: { x: 0, y: 600, width: 1280, height: 120 },
        rect2: { x: 0, y: 0, width: 1280, height: 700 },
        overlapArea: 12800,
        overlapPercent: 0.15,
      }],
      offscreenElements: [],
      zIndexIssues: [],
    };
    const checks = scoreDOMAnalysis(dom, golden);
    expect(checks.find(c => c.name === 'no-overlap:nav+.graph-pane')?.passed).toBe(false);
  });
});

describe('scoreTextAnalysis', () => {
  it('passes when all text found', () => {
    const text: TextAnalysis = {
      visibleTexts: ['review', 'preview', 'other'],
      expectedFound: ['review', 'preview'],
      expectedMissing: [],
    };
    const checks = scoreTextAnalysis(text, golden);
    expect(checks.every(c => c.passed)).toBe(true);
  });

  it('fails when text is missing', () => {
    const text: TextAnalysis = {
      visibleTexts: ['review'],
      expectedFound: ['review'],
      expectedMissing: ['preview'],
    };
    const checks = scoreTextAnalysis(text, golden);
    expect(checks.find(c => c.name === 'text:preview')?.passed).toBe(false);
  });
});

describe('buildComparisonTable', () => {
  it('builds summary from reports', () => {
    const reports: VisualBenchReport[] = [{
      testCase: 'test',
      timestamp: new Date().toISOString(),
      viewport: { width: 1280, height: 720 },
      methods: [
        buildMethodResult('pixel', [
          { name: 'a', passed: true, expected: 'x', actual: 'x' },
          { name: 'b', passed: true, expected: 'y', actual: 'y' },
        ], 5),
        buildMethodResult('dom', [
          { name: 'c', passed: true, expected: 'x', actual: 'x' },
          { name: 'd', passed: false, expected: 'y', actual: 'z' },
        ], 15),
      ],
    }];

    const table = buildComparisonTable(reports);
    expect(table).toHaveLength(2);

    const pixelRow = table.find(s => s.method === 'pixel');
    expect(pixelRow?.accuracy).toBe(1.0);

    const domRow = table.find(s => s.method === 'dom');
    expect(domRow?.accuracy).toBe(0.5);
  });

  it('formats nicely', () => {
    const reports: VisualBenchReport[] = [{
      testCase: 'test',
      timestamp: new Date().toISOString(),
      viewport: { width: 1280, height: 720 },
      methods: [
        buildMethodResult('local', [
          { name: 'a', passed: true, expected: 'x', actual: 'x' },
        ], 10),
      ],
    }];
    const table = buildComparisonTable(reports);
    const output = formatComparisonTable(table);
    expect(output).toContain('COMPARISON TABLE');
    expect(output).toContain('local');
  });
});
