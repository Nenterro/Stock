import { TrendingUp, TrendingDown } from 'lucide-react';
import './PortfolioHero.css';

/**
 * The value card at the top of Portfolio and Graph: what the portfolio is
 * worth and how it moved (left), the all-time figures behind it (right).
 *
 *   value      formatted portfolio value
 *   change     { amount, text, pct, label } - the chip under the value
 *   sparkline  optional array of values to draw small under the chip
 *   stats      groups of stats, [[{ label, value, sub, tone, onClick, active }]]:
 *              each group sits together, with a divider between groups
 */
export default function PortfolioHero({ value, change, sparkline, stats = [] }) {
  const up = (change?.amount ?? 0) >= 0;
  return (
    <div className="glass-panel pf-hero">
      <div className="pf-hero-now">
        <div className="pf-hero-label">Portfolio value</div>
        <div className="pf-hero-value">{value}</div>
        {change && (
          <div className={`pf-day-chip ${up ? 'positive' : 'negative'}`}>
            {up ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
            <span>{change.text}</span>
            {change.pct != null && Number.isFinite(change.pct) && (
              <span className="pf-day-pct">{change.pct >= 0 ? '+' : ''}{change.pct.toFixed(2)}%</span>
            )}
            {change.label && <span className="pf-day-when">{change.label}</span>}
          </div>
        )}
        {sparkline && <Sparkline points={sparkline} />}
      </div>

      <div className="pf-hero-stats">
        {stats.map((group) => (
          <div key={group.map((s) => s.label).join('|')} className="pf-stat-group">
            {group.map((s) => (
              <HeroStat key={s.label} {...s} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function HeroStat({ label, value, sub, tone, onClick, active }) {
  const cls = tone == null ? '' : tone >= 0 ? 'positive' : 'negative';
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={`pf-stat ${onClick ? 'clickable' : ''} ${active ? 'active' : ''}`}
      {...(onClick ? { type: 'button', onClick, 'aria-pressed': Boolean(active) } : {})}
    >
      <span className="pf-stat-label">{label}</span>
      <span className={`pf-stat-value ${cls}`}>{value}</span>
      {sub && <span className="pf-stat-sub">{sub}</span>}
    </Tag>
  );
}

/** Recent portfolio value, drawn small; green or red by direction. */
function Sparkline({ points = [] }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const xy = points.map((v, i) => [(i / (points.length - 1)) * 100, 28 - ((v - min) / span) * 26]);
  const line = xy.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const color = points[points.length - 1] >= points[0] ? '#10b981' : '#ef4444';
  return (
    <svg className="pf-spark" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label="Portfolio value, last 30 days">
      <defs>
        <linearGradient id="pfSparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,30 ${line} 100,30`} fill="url(#pfSparkFill)" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
