import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientSummary } from '../../shared/api';

export interface ClientSwitcherProps {
  clients: ClientSummary[];
  activeId: string;
  activeCompanyName: string;
  disabled?: boolean;
  onSwitch(clientId: string): void | Promise<void>;
}

interface MenuPosition {
  top: number;
  left: number;
  width: number;
}

export function ClientSwitcher({
  clients,
  activeId,
  activeCompanyName,
  disabled = false,
  onSwitch,
}: ClientSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = 'client-switcher-options';

  const positionMenu = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(360, Math.max(0, window.innerWidth - 24));
    const maximumLeft = Math.max(12, window.innerWidth - width - 12);
    setMenuPosition({
      top: rect.bottom + 8,
      left: Math.max(12, Math.min(rect.left, maximumLeft)),
      width,
    });
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    positionMenu();
    container.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', positionMenu, true);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, positionMenu]);

  return (
    <div className="client-switcher" ref={container}>
      <h1 className="client-switcher-heading">
        <button
          ref={trigger}
          aria-controls={menuId}
          aria-expanded={open}
          aria-haspopup="listbox"
          className="client-switcher-trigger"
          disabled={disabled || clients.length < 2}
          onClick={() => {
            const next = !open;
            if (next) positionMenu();
            setOpen(next);
          }}
          type="button"
        >
          <span>{activeCompanyName}</span>
          <span aria-hidden="true" className="client-switcher-caret">⌄</span>
        </button>
      </h1>
      {open && (
        <div
          aria-labelledby={`${menuId}-title`}
          className="client-switcher-menu"
          style={menuPosition ? { top: menuPosition.top, left: menuPosition.left, width: menuPosition.width } : undefined}
        >
          <p className="client-switcher-kicker">Cambiar de cliente</p>
          <h2 className="client-switcher-title" id={`${menuId}-title`}>Un espacio por empresa</h2>
          <p className="client-switcher-description">Cada espacio conserva sus propios datos, reglas y bitácora.</p>
          <div
            aria-label="Clientes"
            className="client-switcher-options"
            id={menuId}
            onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              const options = [...(container.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
              if (options.length === 0) return;
              event.preventDefault();
              const current = options.indexOf(document.activeElement as HTMLElement);
              const next = event.key === 'Home' ? 0
                : event.key === 'End' ? options.length - 1
                  : event.key === 'ArrowDown' ? (current + 1 + options.length) % options.length
                    : (current - 1 + options.length) % options.length;
              options[next].focus();
            }}
            role="listbox"
          >
            {clients.map((client) => {
              const isActive = client.id === activeId;
              const status = client.invoiceCount === 0
                ? 'Cliente ficticio · espacio vacío · 0 facturas'
                : `${client.invoiceCount} facturas · ${client.readyCount} listas para pagar`;
              return (
                <button
                  aria-current={isActive ? 'true' : undefined}
                  aria-selected={isActive}
                  className="client-switcher-option"
                  key={client.id}
                  onClick={() => {
                    setOpen(false);
                    trigger.current?.focus();
                    if (!isActive) void onSwitch(client.id);
                  }}
                  role="option"
                  type="button"
                >
                  <strong>{client.name}</strong>
                  <span>{isActive ? `Activo · ${status}` : status}</span>
                  <span className="client-switcher-meta">{isActive
                    ? 'Datos ficticios'
                    : client.invoiceCount === 0 ? 'Datos separados · sin actividad' : 'Datos ficticios · datos separados'}</span>
                </button>
              );
            })}
          </div>
          <p className="client-switcher-footnote">El cliente activo permanece en el encabezado y sus datos no se mezclan.</p>
        </div>
      )}
    </div>
  );
}
