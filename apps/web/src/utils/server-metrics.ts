import { localize, type Locale } from '../i18n';
import type { ServerHealthStatus, ServerMetricsRange } from '../types';

export const serverMetricsRanges: ServerMetricsRange[] = ['1h', '6h', '24h'];

export function isServerMetricsRange(value: unknown): value is ServerMetricsRange {
  return typeof value === 'string' && serverMetricsRanges.includes(value as ServerMetricsRange);
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function healthFromPercent(value: number): ServerHealthStatus {
  const percent = clampPercent(value);
  if (percent >= 90) return 'critical';
  if (percent >= 75) return 'warning';
  return 'healthy';
}

export function formatMetricPercent(value?: number | null, locale: Locale = 'en'): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale === 'de' ? 'de-DE' : 'en-US', {
    minimumFractionDigits: value > 0 && value < 10 ? 1 : 0,
    maximumFractionDigits: 1,
  }).format(value) + '%';
}

export function formatBytes(value?: number | null, locale: Locale = 'en'): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  if (value === 0) return '0 B';
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** unitIndex;
  const formatted = new Intl.NumberFormat(locale === 'de' ? 'de-DE' : 'en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: scaled >= 100 || unitIndex === 0 ? 0 : 1,
  }).format(scaled);
  return `${formatted} ${units[unitIndex]}`;
}

export function formatByteRate(value?: number | null, locale: Locale = 'en'): string {
  const formatted = formatBytes(value, locale);
  return formatted === '—' ? formatted : `${formatted}/s`;
}

export function formatUptime(value?: number | null, locale: Locale = 'en'): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  const seconds = Math.floor(value);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) {
    return localize(
      `${days}d ${hours}h`,
      `${days} T ${hours} Std.`,
      undefined,
      locale,
    );
  }
  if (hours > 0) {
    return localize(
      `${hours}h ${minutes}m`,
      `${hours} Std. ${minutes} Min.`,
      undefined,
      locale,
    );
  }
  return localize(`${minutes}m`, `${minutes} Min.`, undefined, locale);
}

export function buildMetricChartPath(
  values: number[],
  width: number,
  height: number,
  padding = 0,
): string {
  if (values.length === 0 || width <= padding * 2 || height <= padding * 2) return '';
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;
  return values.map((value, index) => {
    const x = values.length === 1
      ? padding + usableWidth / 2
      : padding + (index / (values.length - 1)) * usableWidth;
    const y = padding + (1 - clampPercent(value) / 100) * usableHeight;
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}
