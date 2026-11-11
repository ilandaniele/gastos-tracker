// Envío de mail por Resend, compartido por los informes y el login por magic link.
// Remitente: MAIL_FROM o, por defecto, el de pruebas de Resend (solo entrega a la dirección dueña de la
// cuenta: para mandar a clientes hace falta un dominio verificado). RESEND_API_URL existe solo para
// apuntar a un mock en las pruebas.
const RESEND_URL = 'https://api.resend.com/emails';

export const hayResend = (env) => !!env.RESEND_API_KEY;

// to: array de direcciones. Devuelve { ok, enviado, a, id } o { ok:false, enviado:false, error }.
export async function enviarMail(env, to, asunto, html) {
  const res = await fetch(env.RESEND_API_URL || RESEND_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM || 'onboarding@resend.dev', to, subject: asunto, html })
  });
  const texto = await res.text();
  if (!res.ok) return { ok: false, enviado: false, error: 'Resend ' + res.status + ': ' + texto.slice(0, 200) };
  let id = '';
  try { id = JSON.parse(texto).id || ''; } catch { /* respuesta sin JSON */ }
  return { ok: true, enviado: true, a: to, id };
}
