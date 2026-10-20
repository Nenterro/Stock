import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, AlertCircle, XCircle, Info } from 'lucide-react';
import { displayTicker } from '../../utils/format';

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

const SYMBOLS = { USD: '$', PKR: 'Rs ', GBP: '£', EUR: '€' };

export function fmtMoney(v, ccy = 'USD', { compact = false, decimals } = {}) {
  if (v == null || !Number.isFinite(v)) return '—';
  const sym = SYMBOLS[ccy] ?? `${ccy} `;
  const abs = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (compact && abs >= 1e3) {
    const units = [
      [1e12, 'T'],
      [1e9, 'B'],
      [1e6, 'M'],
      [1e3, 'K']
    ];
    // PKR readers think in lakh/crore less often in apps than in K/M; keep K/M.
    for (const [n, u] of units) {
      if (abs >= n) return `${sign}${sym}${(abs / n).toFixed(abs / n >= 100 ? 0 : 1)}${u}`;
    }
  }
  const d = decimals ?? (abs >= 1000 ? 0 : 2);
  return `${sign}${sym}${abs.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

export function fmtPct(v, { digits = 1, signed = false } = {}) {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = (v * 100).toFixed(digits);
  // A value that rounds to zero shouldn't read as "-0%".
  if (Number(s) === 0) return `${(0).toFixed(digits)}%`;
  return `${signed && v > 0 ? '+' : ''}${s.replace('-', '−')}%`;
}

export function fmtNum(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: Math.min(digits, Math.abs(v) < 10 ? digits : 0) });
}

export function fmtBig(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return fmtNum(v, 0);
}

export const toneOf = (v) => (v == null ? '' : v > 0 ? 'rs-gain' : v < 0 ? 'rs-loss' : '');

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

export function Panel({ title, subtitle, action, children, className = '' }) {
  return (
    <section className={`rs-panel ${className}`}>
      {(title || action) && (
        <div className="rs-panel-head">
          <div>
            {title && <h2 className="rs-panel-title">{title}</h2>}
            {subtitle && <p className="rs-panel-sub">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone = '', title }) {
  return (
    <div className="rs-stat" title={title}>
      <div className="rs-stat-label">{label}</div>
      <div className={`rs-stat-value ${tone}`}>{value}</div>
      {sub && <div className="rs-stat-sub">{sub}</div>}
    </div>
  );
}

export function Segmented({ options, value, onChange, label }) {
  return (
    <div className="rs-seg" role="group" aria-label={label}>
      {options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const l = typeof o === 'string' ? o : o.label;
        return (
          <button key={v} type="button" className={v === value ? 'active' : ''} aria-pressed={v === value} onClick={() => onChange(v)}>
            {l}
          </button>
        );
      })}
    </div>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="rs-empty">
      {title && <strong>{title}</strong>}
      {children}
    </div>
  );
}

export function Skeleton({ lines = 4 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="rs-skeleton" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

const STATUS_ICON = { good: CheckCircle2, warning: AlertTriangle, serious: AlertCircle, critical: XCircle, info: Info };

/** A status colour never carries meaning alone - it comes with an icon and a label. */
export function Tag({ tone, children, title }) {
  const Icon = STATUS_ICON[tone];
  return (
    <span className={`rs-tag ${tone || ''}`} title={title}>
      {Icon && tone !== 'info' && <Icon size={11} aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Notice({ children }) {
  return (
    <div className="rs-notice" role="note">
      <AlertTriangle size={15} aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

export function SymbolLink({ symbol, name }) {
  return (
    <Link to={`/research/${encodeURIComponent(symbol)}`} className="rs-link">
      <div className="rs-sym">{displayTicker(symbol)}</div>
      {name && <div className="rs-name">{name}</div>}
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/* Bars                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Horizontal magnitude bars: one hue, value labels in text ink, an explicit
 * hatched bar for "Unknown" so undisclosed exposure never passes for a known one.
 */
export function BarList({ rows, max, format = (r) => fmtPct(r.weight), color = 'var(--series-1)', limit = 12, onRowClick }) {
  const shown = rows.slice(0, limit);
  const top = max ?? Math.max(...shown.map((r) => r.weight || 0), 0.0001);
  const rest = rows.slice(limit);
  const restWeight = rest.reduce((a, r) => a + (r.weight || 0), 0);
  return (
    <div className="rs-bars">
      {shown.map((r) => {
        const unknown = /^(unknown|other)$/i.test(r.label);
        return (
          <div
            key={r.key || r.label}
            className="rs-bar-row"
            title={`${r.label}: ${format(r)}${r.title ? ` — ${r.title}` : ''}`}
            onClick={onRowClick ? () => onRowClick(r) : undefined}
            style={onRowClick ? { cursor: 'pointer' } : undefined}
          >
            <span className="rs-bar-label">{r.label}</span>
            <span className="rs-bar-track">
              <span className={`rs-bar-fill ${unknown ? 'unknown' : ''}`} style={{ width: `${Math.max(0, (r.weight / top) * 100)}%`, background: unknown ? undefined : r.color || color }} />
            </span>
            <span className="rs-bar-value">{format(r)}</span>
          </div>
        );
      })}
      {rest.length > 0 && (
        <div className="rs-bar-row rs-muted" title={rest.map((r) => `${r.label} ${format(r)}`).join(', ')}>
          <span className="rs-bar-label">+{rest.length} more</span>
          <span />
          <span className="rs-bar-value">{fmtPct(restWeight)}</span>
        </div>
      )}
    </div>
  );
}

/** Two-segment bar: direct holding vs exposure through funds. */
export function SplitBars({ rows, total, currency, limit = 15, segments }) {
  const shown = rows.slice(0, limit);
  const top = Math.max(...shown.map((r) => r.value), 0.0001);
  return (
    <>
      <div className="rs-legend">
        {segments.map((s) => (
          <span key={s.key} className="rs-legend-item">
            <span className="rs-swatch" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div className="rs-bars">
        {shown.map((r) => {
          const parts = segments.map((s) => ({ ...s, v: r[s.key] || 0 })).filter((p) => p.v > 0);
          const tip = `${r.label}: ${fmtPct(r.value / total)} of portfolio (${fmtMoney(r.value, currency, { compact: true })}) — ${parts
            .map((p) => `${p.label.toLowerCase()} ${fmtMoney(p.v, currency, { compact: true })}`)
            .join(', ')}${r.sub ? ` · ${r.sub}` : ''}`;
          return (
            <div key={r.key} className="rs-bar-row" title={tip}>
              <span className="rs-bar-label">{r.label}</span>
              <span className="rs-bar-track" style={{ background: 'transparent' }}>
                {parts.map((p, i) => (
                  <span
                    key={p.key}
                    className={`rs-bar-fill ${i < parts.length - 1 ? 'seg-first' : ''}`}
                    style={{ width: `${(p.v / top) * 100}%`, background: p.color }}
                  />
                ))}
              </span>
              <span className="rs-bar-value">{fmtPct(r.value / total)}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Charts                                                                     */
/* -------------------------------------------------------------------------- */

/** Recharts tooltip in the app's style; values stay in text ink. */
export function ChartTooltip({ active, payload, label, formatter = (v) => v, labelFormatter = (l) => l }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rs-tooltip">
      <div>{labelFormatter(label)}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="rs-tooltip-row">
          <span className="rs-swatch" style={{ background: p.color || p.stroke }} />
          {p.name}
          <b>{formatter(p.value, p)}</b>
        </div>
      ))}
    </div>
  );
}

/** Diverging blue (positive) / red (negative) with a grey midpoint at 0. */
export function divergingColor(v) {
  if (v == null) return 'rgba(255,255,255,0.03)';
  const t = Math.max(-1, Math.min(1, v));
  const mix = (a, b, k) => Math.round(a + (b - a) * k);
  const mid = [0x38, 0x38, 0x35];
  const end = t >= 0 ? [0x39, 0x87, 0xe5] : [0xe6, 0x67, 0x67];
  const k = Math.abs(t);
  return `rgb(${mix(mid[0], end[0], k)}, ${mix(mid[1], end[1], k)}, ${mix(mid[2], end[2], k)})`;
}

/* -------------------------------------------------------------------------- */
/* Markdown                                                                   */
/* -------------------------------------------------------------------------- */

export function Markdown({ children }) {
  return (
    <div className="rs-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: c }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {c}
            </a>
          )
        }}
      >
        {children || ''}
      </ReactMarkdown>
    </div>
  );
}

export function Sources({ sources, asOf }) {
  if (!sources?.length) return null;
  return (
    <p className="rs-sources">
      Source{sources.length > 1 ? 's' : ''}:{' '}
      {sources.map((s, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {s.url ? (
            <a href={s.url} target="_blank" rel="noopener noreferrer">
              {s.name}
            </a>
          ) : (
            s.name
          )}
          {s.covers ? ` (${s.covers})` : ''}
        </span>
      ))}
      {asOf && ` · fetched ${String(asOf).slice(0, 10)}`}
    </p>
  );
}
