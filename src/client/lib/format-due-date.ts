const dueDateFormatter = new Intl.DateTimeFormat('es-VE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatDueDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return value;

  return dueDateFormatter.format(date).replace(/\.(?=\s)/g, '');
}
