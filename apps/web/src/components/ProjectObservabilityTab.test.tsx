import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nProvider, useI18n } from '../i18n';
import type { ProjectObservabilityHistoryPoint, ProjectObservabilityWarning } from '../types';
import { ProjectHistoryChart, projectWarningCopy } from './ProjectObservabilityTab';

function historyPoint(sampledAt: string, cpu: number, memory: number): ProjectObservabilityHistoryPoint {
  return {
    sampledAt,
    cpuUsagePercent: cpu,
    memoryUsedBytes: memory * 10_000_000,
    memoryLimitBytes: 1_000_000_000,
    memoryUsagePercent: memory,
    networkReceiveBytesPerSecond: 1_000,
    networkTransmitBytesPerSecond: 500,
    blockReadBytes: 10_000,
    blockWriteBytes: 5_000,
  };
}

function WarningCopy({ warning }: { warning: ProjectObservabilityWarning }) {
  const { t } = useI18n();
  const copy = projectWarningCopy(warning, t);
  return <div data-action={copy.action}><strong>{copy.title}</strong><p>{copy.description}</p></div>;
}

describe('ProjectObservabilityTab presentation', () => {
  it('renders CPU and memory relative to project limits in a responsive SVG timeline', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ProjectHistoryChart
          cpuLimitCores={0.5}
          history={[
            historyPoint('2026-07-16T08:00:00.000Z', 10, 20),
            historyPoint('2026-07-16T08:00:15.000Z', 25, 40),
            historyPoint('2026-07-16T08:00:30.000Z', 40, 65),
          ]}
        />
      </I18nProvider>,
    );

    expect(html).toContain('CPU limit utilization');
    expect(html).toContain('Memory limit utilization');
    expect(html).toContain('CPU and memory utilization over time');
    expect(html).toContain('3 samples');
    expect((html.match(/<path/g) ?? [])).toHaveLength(2);
  });

  it('turns OOM and restart diagnostics into concrete actions', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <WarningCopy warning={{ id: 'oom', severity: 'critical' }} />
        <WarningCopy warning={{ id: 'restarts', severity: 'warning', value: 4 }} />
      </I18nProvider>,
    );

    expect(html).toContain('terminated for using too much memory');
    expect(html).toContain('data-action="settings"');
    expect(html).toContain('4 runtime restarts detected');
    expect(html).toContain('data-action="logs"');
  });
});
