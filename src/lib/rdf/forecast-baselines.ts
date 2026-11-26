/**
 * Simple forecast baselines for time-series evaluation in Reckons.AI
 *
 * This module implements basic forecasting methods that are used as baselines
 * to evaluate more complex models like Timestral. The baselines must be simple,
 * deterministic, and work without external dependencies.
 */

export type Point = {
  at: string; // ISO time string
  value: number;
};

/**
 * Forecast using the last observed value (naive approach)
 *
 * @param history - Historical time series data points
 * @param horizon - Number of steps to forecast
 * @returns Array of forecasted values
 * @throws Error when history is insufficient
 */
function checkHorizon(horizon: number): void {
  if (!Number.isInteger(horizon) || horizon < 0) {
    throw new Error("Horizon must be a non-negative integer");
  }
}

export function naiveForecast(history: Point[], horizon: number): number[] {
  checkHorizon(horizon);
  if (history.length === 0) {
    throw new Error("History must not be empty");
  }

  const lastValue = history[history.length - 1].value;
  return Array(horizon).fill(lastValue);
}

/**
 * Forecast using a moving average over a specified window
 *
 * @param history - Historical time series data points
 * @param horizon - Number of steps to forecast
 * @param window - Size of the moving window (must be positive)
 * @returns Array of forecasted values
 * @throws Error when history is insufficient or window is invalid
 */
export function movingAverageForecast(history: Point[], horizon: number, window: number): number[] {
  checkHorizon(horizon);
  if (history.length === 0) {
    throw new Error("History must not be empty");
  }

  if (window <= 0) {
    throw new Error("Window size must be positive");
  }

  if (history.length < window) {
    throw new Error(`History length (${history.length}) is less than window size (${window})`);
  }

  // Calculate the moving average
  let sum = 0;
  for (let i = history.length - window; i < history.length; i++) {
    sum += history[i].value;
  }

  const average = sum / window;
  return Array(horizon).fill(average);
}

/**
 * Forecast using seasonal naive approach with a specified period
 *
 * @param history - Historical time series data points
 * @param horizon - Number of steps to forecast
 * @param period - The seasonal period (e.g., 7 for weekly seasonality)
 * @returns Array of forecasted values
 * @throws Error when history is insufficient or period is invalid
 */
export function seasonalNaiveForecast(history: Point[], horizon: number, period: number): number[] {
  checkHorizon(horizon);
  if (history.length === 0) {
    throw new Error("History must not be empty");
  }

  if (period <= 0) {
    throw new Error("Period must be positive");
  }

  if (history.length < period) {
    throw new Error(`History length (${history.length}) is less than period (${period})`);
  }

  // Step h repeats the value one period before it: history[n - period + (h mod period)].
  // (Repeating a single value would collapse the seasonal pattern into a flat line.)
  const start = history.length - period;
  return Array.from({ length: horizon }, (_, h) => history[start + (h % period)].value);
}

/**
 * Calculate Mean Absolute Error between actual and predicted values
 *
 * @param actual - Actual values
 * @param predicted - Predicted values
 * @returns Mean absolute error
 * @throws Error when arrays have different lengths or are empty
 */
export function meanAbsoluteError(actual: number[], predicted: number[]): number {
  if (actual.length !== predicted.length) {
    throw new Error(`Actual and predicted arrays must have the same length. Actual: ${actual.length}, Predicted: ${predicted.length}`);
  }

  if (actual.length === 0) {
    throw new Error("Arrays must not be empty");
  }

  let sum = 0;
  for (let i = 0; i < actual.length; i++) {
    sum += Math.abs(actual[i] - predicted[i]);
  }

  return sum / actual.length;
}

/**
 * Score multiple baselines on a given history and holdout data
 *
 * @param history - Historical time series data points
 * @param holdout - Holdout data to evaluate against
 * @param period - Seasonal period for seasonal naive forecast
 * @returns Array of {name, mae} objects sorted by MAE (best first)
 */
export function scoreBaselines(history: Point[], holdout: Point[], period: number): { name: string; mae: number }[] {
  const horizon = holdout.length;
  if (horizon === 0) throw new Error("Holdout must not be empty");

  // Fit and evaluate each baseline
  const naiveResult = naiveForecast(history, horizon);
  const naiveMAE = meanAbsoluteError(holdout.map(p => p.value), naiveResult);

  // Window of 3, or the whole history when it is shorter (so a short history still scores).
  const movingAvgResult = movingAverageForecast(history, horizon, Math.min(3, history.length));
  const movingAvgMAE = meanAbsoluteError(holdout.map(p => p.value), movingAvgResult);

  const seasonalNaiveResult = seasonalNaiveForecast(history, horizon, period);
  const seasonalNaiveMAE = meanAbsoluteError(holdout.map(p => p.value), seasonalNaiveResult);

  // Return results sorted by MAE (best first)
  return [
    { name: "seasonal_naive", mae: seasonalNaiveMAE },
    { name: "moving_average", mae: movingAvgMAE },
    { name: "naive", mae: naiveMAE }
  ].sort((a, b) => a.mae - b.mae);
}