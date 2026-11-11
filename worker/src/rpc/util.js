// Helpers compartidos por los módulos de la API de escritura (src/rpc/*.js).
export const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(new Date());
// Fuente de verdad por defecto de un módulo cuando settings no dice nada: el tenant original ('ilan') sigue
// atado al Sheet hasta que lo corta a mano; cualquier cuenta nueva nace sobre D1 (no tiene Sheet).
export const fuenteDefecto = (tenant) => (tenant === 'ilan' ? 'sheet' : 'd1');
export const idDe = (d) => { const n = parseInt(d && (d.row != null ? d.row : d.id), 10); if (!Number.isFinite(n) || n < 1) throw new Error('Fila inválida'); return n; };
