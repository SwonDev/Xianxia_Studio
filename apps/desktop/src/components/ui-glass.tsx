/**
 * Liquid Glass UI primitives (DESIGN.md v2) — TSX port of the React
 * primitives in /design/shell.jsx (PageHeader, Group, Row). Shared by
 * every ported screen so the inset-grouped-list language is consistent.
 * Pure presentational; no data, no demo content.
 */
import type { ReactNode, CSSProperties } from 'react';
import { CaretRight, type Icon as PhosphorIcon } from '@phosphor-icons/react';

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 24,
        marginBottom: 24,
      }}
    >
      <div style={{ maxWidth: 560 }}>
        <h1 className="title-l" style={{ margin: 0 }}>
          {title}
        </h1>
        {subtitle && (
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 13, lineHeight: 1.45 }}>
            {subtitle}
          </p>
        )}
      </div>
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </header>
  );
}

export function Group({
  label,
  footer,
  children,
}: {
  label?: string;
  footer?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 22 }}>
      {label && <div className="group-label">{label}</div>}
      <div className="group">{children}</div>
      {footer && (
        <div className="group-label" style={{ marginTop: 6, color: 'var(--text-tertiary)' }}>
          {footer}
        </div>
      )}
    </div>
  );
}

export function Row({
  icon: Icon,
  iconColor,
  title,
  sub,
  value,
  control,
  onClick,
  chev,
  hoverable,
}: {
  icon?: PhosphorIcon;
  iconColor?: string;
  title: ReactNode;
  sub?: ReactNode;
  value?: ReactNode;
  control?: ReactNode;
  onClick?: () => void;
  chev?: boolean;
  hoverable?: boolean;
}) {
  const cls =
    'row' + (Icon ? ' with-icon' : '') + (hoverable || onClick ? ' row-hoverable' : '');
  return (
    <div className={cls} onClick={onClick} role={onClick ? 'button' : undefined}>
      {Icon && (
        <span
          className="lg-tile md row-icon"
          style={{ '--tint': iconColor || '#a88a3c' } as CSSProperties}
        >
          <Icon size={14} />
        </span>
      )}
      <div className="row-label">
        <div className="row-title">{title}</div>
        {sub && <div className="row-sub">{sub}</div>}
      </div>
      {value && <span className="row-value">{value}</span>}
      {control}
      {chev && <CaretRight size={12} className="chev" />}
    </div>
  );
}
