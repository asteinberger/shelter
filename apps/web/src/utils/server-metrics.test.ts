import { describe, expect, it } from 'vitest';
import {
  buildMetricChartPath,
  clampPercent,
  formatByteRate,
  formatBytes,
  formatMetricPercent,
  formatUptime,
  healthFromPercent,
  isServerMetricsRange,
} from './server-metrics';

describe('server metric utilities', () => {
  it('validates supported history ranges', () => {
    expect(isServerMetricsRange('1h')).toBe(true);
    expect(isServerMetricsRange('24h')).toBe(true);
    expect(isServerMetricsRange('7d')).toBe(false);
  });

  it('clamps percentages and derives resource health', () => {
    expect(clampPercent(-2)).toBe(0);
    expect(clampPercent(104)).toBe(100);
    expect(healthFromPercent(74.9)).toBe('healthy');
    expect(healthFromPercent(75)).toBe('warning');
    expect(healthFromPercent(90)).toBe('critical');
  });

  it('formats byte values, rates, percentages, and uptime by locale', () => {
    expect(formatBytes(1_610_612_736, 'en')).toBe('1.5 GB');
    expect(formatBytes(1_610_612_736, 'de')).toBe('1,5 GB');
    expect(formatByteRate(1_048_576, 'en')).toBe('1 MB/s');
    expect(formatMetricPercent(7.25, 'en')).toBe('7.3%');
    expect(formatMetricPercent(82.25, 'de')).toBe('82,3%');
    expect(formatUptime(183_900, 'en')).toBe('2d 3h');
    expect(formatUptime(3_900, 'de')).toBe('1 Std. 5 Min.');
  });

  it('builds a bounded SVG path and handles empty series', () => {
    expect(buildMetricChartPath([], 100, 100, 10)).toBe('');
    expect(buildMetricChartPath([0, 50, 120], 100, 100, 10)).toBe(
      'M10.00,90.00 L50.00,50.00 L90.00,10.00',
    );
  });
});
