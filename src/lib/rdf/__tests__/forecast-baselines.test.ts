import { describe, it, expect } from 'vitest';

import {
  type Point,
  naiveForecast,
  movingAverageForecast,
  seasonalNaiveForecast,
  meanAbsoluteError,
  scoreBaselines
} from "../forecast-baselines";

describe("forecast baselines", () => {
  // Test data for synthetic series
  const flatSeries: Point[] = [
    { at: "2023-01-01T00:00:00Z", value: 5 },
    { at: "2023-01-02T00:00:00Z", value: 5 },
    { at: "2023-01-03T00:00:00Z", value: 5 },
    { at: "2023-01-04T00:00:00Z", value: 5 },
    { at: "2023-01-05T00:00:00Z", value: 5 }
  ];

  const weeklyPattern: Point[] = [
    { at: "2023-01-01T00:00:00Z", value: 10 },
    { at: "2023-01-02T00:00:00Z", value: 15 },
    { at: "2023-01-03T00:00:00Z", value: 20 },
    { at: "2023-01-04T00:00:00Z", value: 25 },
    { at: "2023-01-05T00:00:00Z", value: 30 },
    { at: "2023-01-06T00:00:00Z", value: 35 },
    { at: "2023-01-07T00:00:00Z", value: 40 }
  ];

  const rampSeries: Point[] = [
    { at: "2023-01-01T00:00:00Z", value: 1 },
    { at: "2023-01-02T00:00:00Z", value: 2 },
    { at: "2023-01-03T00:00:00Z", value: 3 },
    { at: "2023-01-04T00:00:00Z", value: 4 },
    { at: "2023-01-05T00:00:00Z", value: 5 }
  ];

  describe("naiveForecast", () => {
    it("should forecast the last value for a flat series", () => {
      const result = naiveForecast(flatSeries, 3);
      expect(result).toEqual([5, 5, 5]);
    });

    it("should throw an error when history is empty", () => {
      expect(() => naiveForecast([], 1)).toThrow("History must not be empty");
    });
  });

  describe("movingAverageForecast", () => {
    it("should calculate moving average correctly", () => {
      const result = movingAverageForecast(rampSeries, 2, 3);
      // Average of [3, 4, 5] = 4
      expect(result).toEqual([4, 4]);
    });

    it("should throw an error when history is empty", () => {
      expect(() => movingAverageForecast([], 1, 1)).toThrow("History must not be empty");
    });

    it("should throw an error when window size is invalid", () => {
      expect(() => movingAverageForecast(rampSeries, 1, 0)).toThrow("Window size must be positive");
      expect(() => movingAverageForecast(rampSeries, 1, -1)).toThrow("Window size must be positive");
    });

    it("should throw an error when history is shorter than window", () => {
      expect(() => movingAverageForecast([{ at: "2023-01-01T00:00:00Z", value: 5 }], 1, 2))
        .toThrow("History length (1) is less than window size (2)");
    });
  });

  describe("seasonalNaiveForecast", () => {
    it("should repeat the pattern one period earlier, step by step", () => {
      const result = seasonalNaiveForecast(weeklyPattern, 3, 7);
      expect(result).toEqual([10, 15, 20]);
    });

    it("wraps around after a full period", () => {
      expect(seasonalNaiveForecast(weeklyPattern, 9, 7)).toEqual([10, 15, 20, 25, 30, 35, 40, 10, 15]);
    });

    it("should throw an error when history is empty", () => {
      expect(() => seasonalNaiveForecast([], 1, 1)).toThrow("History must not be empty");
    });

    it("should throw an error when period is invalid", () => {
      expect(() => seasonalNaiveForecast(weeklyPattern, 1, 0)).toThrow("Period must be positive");
      expect(() => seasonalNaiveForecast(weeklyPattern, 1, -1)).toThrow("Period must be positive");
    });

    it("should throw an error when history is shorter than period", () => {
      expect(() => seasonalNaiveForecast([{ at: "2023-01-01T00:00:00Z", value: 5 }], 1, 2))
        .toThrow("History length (1) is less than period (2)");
    });
  });

  describe("meanAbsoluteError", () => {
    it("should calculate MAE correctly", () => {
      const actual = [1, 2, 3, 4];
      const predicted = [1, 3, 3, 5];
      const mae = meanAbsoluteError(actual, predicted);
      expect(mae).toBeCloseTo(0.5); // (0 + 1 + 0 + 1) / 4 = 0.5
    });

    it("should throw an error when arrays have different lengths", () => {
      expect(() => meanAbsoluteError([1, 2, 3], [1, 2])).toThrow(
        "Actual and predicted arrays must have the same length"
      );
    });

    it("should throw an error when arrays are empty", () => {
      expect(() => meanAbsoluteError([], [])).toThrow("Arrays must not be empty");
    });
  });

  describe("scoreBaselines", () => {
    const day = (n: number) => new Date(Date.UTC(2023, 0, n)).toISOString();
    const weekly = [10, 15, 20, 25, 30, 35, 40];
    const makeWeekly = (from: number, count: number): Point[] =>
      Array.from({ length: count }, (_, i) => ({ at: day(from + i), value: weekly[(from - 1 + i) % 7] }));

    it("ranks seasonal naive first on a weekly pattern, with exact forecast", () => {
      const history = makeWeekly(1, 14);
      const holdout = makeWeekly(15, 7);
      const results = scoreBaselines(history, holdout, 7);
      expect(results[0]).toEqual({ name: "seasonal_naive", mae: 0 });
      expect(results.map((r) => r.name).sort()).toEqual(["moving_average", "naive", "seasonal_naive"]);
      expect(results[1].mae).toBeGreaterThan(0);
      expect(results[2].mae).toBeGreaterThan(0);
    });

    it("is sorted best first", () => {
      const results = scoreBaselines(makeWeekly(1, 14), makeWeekly(15, 7), 7);
      for (let i = 1; i < results.length; i++) expect(results[i].mae).toBeGreaterThanOrEqual(results[i - 1].mae);
    });

    it("scores every baseline at zero on a flat series", () => {
      const holdout = flatSeries.map((p) => ({ ...p }));
      const results = scoreBaselines(flatSeries, holdout, 2);
      expect(results.every((r) => r.mae === 0)).toBe(true);
    });

    it("throws when the holdout is empty", () => {
      expect(() => scoreBaselines(flatSeries, [], 2)).toThrow("Holdout must not be empty");
    });
  });

  describe("all baselines", () => {
    it("forecast a flat series exactly", () => {
      expect(naiveForecast(flatSeries, 2)).toEqual([5, 5]);
      expect(movingAverageForecast(flatSeries, 2, 3)).toEqual([5, 5]);
      expect(seasonalNaiveForecast(flatSeries, 2, 2)).toEqual([5, 5]);
    });

    it("naive is worse than seasonal naive on a weekly pattern; moving average of a ramp lags", () => {
      const next = [10, 15, 20];
      expect(meanAbsoluteError(next, naiveForecast(weeklyPattern, 3))).toBeGreaterThan(
        meanAbsoluteError(next, seasonalNaiveForecast(weeklyPattern, 3, 7))
      );
      // ramp 1..5 continues 6: the average of the last three (4) lags behind it
      expect(movingAverageForecast(rampSeries, 1, 3)[0]).toBeLessThan(6);
    });

    it("reject a negative horizon", () => {
      expect(() => naiveForecast(flatSeries, -1)).toThrow("Horizon");
    });
  });
});
