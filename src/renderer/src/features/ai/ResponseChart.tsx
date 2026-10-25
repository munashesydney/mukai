import { useContext, useEffect, useId, useMemo, useState, type PointerEvent } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import {
  inlineChartSchema,
  parseChartBlock,
  type ResponseChart,
} from '../../../../shared/responseCharts';
import { artifactService } from '../../services/artifactService';
import { ResponseReferenceContext } from './responseReferenceContext';
import { errorText } from '../../utils/errors';

const colors = ['var(--theme-accent)', '#409fca', '#d79c36', '#52a383'];
const number = (value: number) =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(value);
function csvCell(value: unknown) {
  const text = String(value ?? '');
  return (
    '"' +
    (/^[=+\-@\t\r]/.test(text) && typeof value === 'string' ? "'" + text : text).replaceAll(
      '"',
      '""',
    ) +
    '"'
  );
}

export function ResponseChartView({ chart }: { chart: ResponseChart }) {
  const titleId = useId();
  const tooltipId = useId();
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<{ row: number; series: number } | null>(null);
  const selectedRow = hovered ?? focused?.row ?? null;
  const activeRow = selectedRow !== null && chart.data[selectedRow] ? selectedRow : null;
  const width = 640,
    height = 310,
    left = 62,
    right = 18,
    top = 18,
    bottom = 52;
  const plotWidth = width - left - right,
    plotHeight = height - top - bottom;
  const values = chart.data.flatMap((row) =>
    chart.series.flatMap((series) =>
      typeof row[series.key] === 'number' ? [row[series.key] as number] : [],
    ),
  );
  const min = Math.min(0, ...values),
    max = Math.max(0, ...values);
  const low = min === max ? min - 1 : min,
    high = min === max ? max + 1 : max;
  const y = (value: number) => top + ((high - value) / (high - low)) * plotHeight;
  const x = (index: number) => left + ((index + 0.5) / chart.data.length) * plotWidth;
  const ticks = Array.from({ length: 5 }, (_, index) => low + ((high - low) * index) / 4);
  const labelStep = Math.max(1, Math.ceil(chart.data.length / 7));
  const columns = [chart.xKey, ...chart.series.map((series) => series.key)];
  function inspect(event: PointerEvent<SVGSVGElement>, toggle = false) {
    const transform = event.currentTarget.getScreenCTM();
    if (!transform) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse());
    const index =
      point.x < left || point.x > width - right || point.y < top || point.y > height - bottom
        ? null
        : Math.min(
            chart.data.length - 1,
            Math.floor(((point.x - left) / plotWidth) * chart.data.length),
          );
    setHovered((previous) => (toggle && previous === index ? null : index));
  }
  function download() {
    const csv = [
      columns.map(csvCell).join(','),
      ...chart.data.map((row) => columns.map((key) => csvCell(row[key])).join(',')),
    ].join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'chart-data.csv';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section
      className="response-chart"
      aria-labelledby={titleId}
      data-inspecting={activeRow !== null || undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setHovered(null);
          setFocused(null);
        }
      }}
    >
      <div className="response-chart-heading">
        <strong id={titleId}>{chart.title}</strong>
        <button type="button" className="text-button" onClick={download}>
          <Download size={14} /> Download data
        </button>
      </div>
      <div className="response-chart-legend">
        {chart.series.map((series, index) => (
          <span key={series.key}>
            <i style={{ background: colors[index] }} />
            {series.label || series.key}
          </span>
        ))}
      </div>
      <div className="response-chart-plot">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby={titleId}
          onPointerMove={(event) => {
            if (event.pointerType !== 'touch') inspect(event);
          }}
          onPointerDown={(event) => {
            if (event.pointerType === 'touch') inspect(event, true);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== 'touch') setHovered(null);
          }}
        >
          <desc>
            {chart.type === 'bar' ? 'Bar' : 'Line'} chart with {chart.data.length} categories. Focus
            or hover a value for details, or open the data table below.
          </desc>
          <rect
            x={left}
            y={top}
            width={plotWidth}
            height={plotHeight}
            fill="transparent"
            className="response-chart-hit-area"
          />
          {activeRow !== null && (
            <g className="response-chart-guide" aria-hidden="true" pointerEvents="none">
              <rect
                x={left + (activeRow / chart.data.length) * plotWidth}
                y={top}
                width={plotWidth / chart.data.length}
                height={plotHeight}
                className="response-chart-hover-band"
              />
              <line
                x1={x(activeRow)}
                x2={x(activeRow)}
                y1={top}
                y2={height - bottom}
                className="response-chart-crosshair"
              />
            </g>
          )}
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={left}
                x2={width - right}
                y1={y(tick)}
                y2={y(tick)}
                className="response-chart-grid"
              />
              <text x={left - 9} y={y(tick) + 4} textAnchor="end">
                {number(tick)}
              </text>
            </g>
          ))}
          {chart.data.map((row, index) =>
            index % labelStep === 0 ? (
              <text key={index} x={x(index)} y={height - 21} textAnchor="middle">
                {String(row[chart.xKey]).slice(0, 16)}
              </text>
            ) : null,
          )}
          {chart.series.map((series, seriesIndex) => {
            let drawing = false;
            const path = chart.data
              .map((row, index) => {
                const value = row[series.key];
                if (typeof value !== 'number') {
                  drawing = false;
                  return '';
                }
                const command = drawing ? 'L' : 'M';
                drawing = true;
                return `${command}${x(index)},${y(value)}`;
              })
              .join(' ');
            return (
              <g key={series.key} style={{ color: colors[seriesIndex] }}>
                {chart.type === 'line' && (
                  <path d={path} fill="none" stroke="currentColor" strokeWidth="2" />
                )}
                {chart.data.map((row, index) => {
                  const value = row[series.key];
                  if (typeof value !== 'number') return null;
                  const label = `${row[chart.xKey]} · ${series.label || series.key}: ${value}`;
                  const events = {
                    tabIndex: 0,
                    'aria-label': label,
                    'aria-describedby': activeRow === index ? tooltipId : undefined,
                    onFocus: () => setFocused({ row: index, series: seriesIndex }),
                    onBlur: () => setFocused(null),
                  };
                  const barWidth = ((plotWidth / chart.data.length) * 0.75) / chart.series.length;
                  return chart.type === 'bar' ? (
                    <rect
                      key={index}
                      {...events}
                      className={`response-chart-mark ${activeRow === index ? 'is-active' : ''}`}
                      x={x(index) - (barWidth * chart.series.length) / 2 + seriesIndex * barWidth}
                      width={Math.max(0.2, barWidth - 1)}
                      y={Math.min(y(0), y(value))}
                      height={Math.max(0.5, Math.abs(y(0) - y(value)))}
                      fill="currentColor"
                    />
                  ) : (
                    <circle
                      key={index}
                      {...events}
                      className={`response-chart-mark ${activeRow === index ? 'is-active' : ''}`}
                      cx={x(index)}
                      cy={y(value)}
                      r={activeRow === index ? 6 : 4}
                      fill="currentColor"
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
        {activeRow !== null && (
          <div
            id={tooltipId}
            role="tooltip"
            className="response-chart-hover-card"
            style={{
              left: `clamp(8px, calc(${(x(activeRow) / width) * 100}% - 110px), calc(100% - 228px))`,
            }}
          >
            <strong>{String(chart.data[activeRow][chart.xKey])}</strong>
            {chart.series.map((series, index) => (
              <div key={series.key}>
                <span>
                  <i style={{ background: colors[index] }} />
                  {series.label || series.key}
                </span>
                <b>
                  {chart.data[activeRow][series.key] === null
                    ? '—'
                    : Number(chart.data[activeRow][series.key]).toLocaleString(undefined, {
                        maximumSignificantDigits: 15,
                      })}
                </b>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="response-chart-tooltip" role="status">
        {activeRow !== null
          ? `${chart.data[activeRow][chart.xKey]} · ${chart.series.map((series) => `${series.label || series.key}: ${chart.data[activeRow][series.key] ?? '—'}`).join(' · ')}`
          : 'Hover, focus, or tap a category to explore its values.'}
      </p>
      <details>
        <summary>View data table</summary>
        <div className="response-chart-table">
          <table>
            <thead>
              <tr>
                {columns.map((key, index) => (
                  <th key={key}>{index ? chart.series[index - 1].label || key : key}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chart.data.map((row, index) => (
                <tr key={index}>
                  {columns.map((key) => (
                    <td key={key}>{row[key] === null ? '—' : String(row[key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

export function ChartLoading({ label = 'Reviewing chart…' }: { label?: string }) {
  return (
    <p className="response-chart-loading" role="status">
      <LoaderCircle size={15} className="is-spinning" aria-hidden="true" />
      <span>{label}</span>
    </p>
  );
}

function SavedChart({ source }: { source: string }) {
  const conversationId = useContext(ResponseReferenceContext);
  const [chart, setChart] = useState<ResponseChart | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    if (!conversationId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const { blob } = await artifactService.reference(
          conversationId,
          source,
          false,
          controller.signal,
        );
        if (blob.size > 256 * 1024)
          throw new Error('This saved chart exceeds the 256 KiB chart limit.');
        let data: ResponseChart;
        try {
          data = inlineChartSchema.parse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer())),
          );
        } catch {
          throw new Error('The saved file is not a valid version 1 chart specification.');
        }
        if (!controller.signal.aborted) setChart(data);
      } catch (error) {
        if (!controller.signal.aborted) setError(errorText(error));
      }
    })();
    return () => controller.abort();
  }, [conversationId, source]);
  if (!conversationId) return <p role="alert">Open the conversation to view this saved chart.</p>;
  return chart ? (
    <ResponseChartView chart={chart} />
  ) : error ? (
    <p role="alert" className="ai-alert">
      This chart could not be displayed. {error}
    </p>
  ) : (
    <ChartLoading label="Loading chart…" />
  );
}

export function ResponseChartBlock({ source }: { source: string }) {
  const parsed = useMemo(() => {
    try {
      return { chart: parseChartBlock(source) };
    } catch (error) {
      return { error: errorText(error) };
    }
  }, [source]);
  if (!parsed.chart)
    return (
      <div className="ai-alert" role="alert">
        {parsed.error}
      </div>
    );
  return 'source' in parsed.chart ? (
    <SavedChart key={parsed.chart.source} source={parsed.chart.source} />
  ) : (
    <ResponseChartView chart={parsed.chart} />
  );
}
