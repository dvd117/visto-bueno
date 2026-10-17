import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComoDecide } from '../../src/client/features/ayuda/ComoDecide';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ComoDecide', () => {
  it('is inert while closed', () => {
    const { container } = render(<ComoDecide open={false} onClose={vi.fn()} />);
    const layer = container.querySelector('.ayuda-overlay');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(layer?.getAttribute('aria-hidden')).toBe('true');
    expect(layer?.hasAttribute('inert')).toBe(true);
  });

  it('shows an accessible guide and closes with its explicit action', () => {
    const onClose = vi.fn();
    render(<ComoDecide open onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: 'Cómo decide el agente' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar panel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Ayuda';
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const { rerender } = render(<ComoDecide open onClose={onClose} />);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cerrar panel' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();

    rerender(<ComoDecide open={false} onClose={onClose} />);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('keeps Tab navigation inside the open dialog', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    render(<ComoDecide open onClose={vi.fn()} />);
    const close = screen.getByRole('button', { name: 'Cerrar panel' });
    const download = screen.getByRole('button', { name: 'Descargar guía en Markdown' });

    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(download);

    fireEvent.keyDown(download, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    expect(document.activeElement).not.toBe(trigger);
    trigger.remove();
  });

  it('downloads the same guide content as Markdown using a local Blob', async () => {
    let downloaded: Blob | undefined;
    const createObjectURL = vi.fn((blob: Blob) => {
      downloaded = blob;
      return 'blob:como-decide';
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<ComoDecide open onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Descargar guía en Markdown' }));

    expect(click).toHaveBeenCalledOnce();
    expect(click.mock.instances[0].getAttribute('download')).toBe('como-decide.md');
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(downloaded?.type).toBe('text/markdown;charset=utf-8');
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(downloaded as Blob);
    });
    expect(text).toContain('# Cómo decide el agente');
    expect(text).toContain('## El recorrido: seis pasos');
    expect(text).toContain('**Frenada.**');
    expect(text).toContain('Identidad declarada');
    expect(text).toContain('No confirma un pago ni inicia una transferencia');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:como-decide');
  });
});
