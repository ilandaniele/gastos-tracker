// Helpers compartidos por los módulos de la API de escritura (src/rpc/*.js).
export const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(new Date());
export const idDe = (d) => { const n = parseInt(d && (d.row != null ? d.row : d.id), 10); if (!Number.isFinite(n) || n < 1) throw new Error('Fila inválida'); return n; };
