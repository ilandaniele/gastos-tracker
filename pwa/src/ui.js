// El shell de la PWA y su service worker. Van como texto en el Worker para no
// depender de un bundler ni de assets sueltos.

export const SHELL_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Gastos">
<meta name="theme-color" content="#0f766e">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon-192.png">
<title>Gastos</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #f6f7f9;
               font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #app { position: fixed; inset: 0; border: 0; width: 100%; height: 100%; }
  /* El botón solo aparece si faltan permisos. Una vez activado no molesta más. */
  #bell { position: fixed; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom));
          z-index: 10; border: 0; border-radius: 999px; padding: 12px 18px;
          background: #0f766e; color: #fff; font-size: 15px; font-weight: 600;
          box-shadow: 0 4px 14px rgba(0,0,0,.25); display: none; }
  #bell.show { display: block; }
  #toast { position: fixed; left: 16px; right: 16px; bottom: calc(76px + env(safe-area-inset-bottom));
           z-index: 11; background: #111827; color: #fff; border-radius: 10px;
           padding: 12px 14px; font-size: 14px; display: none; line-height: 1.35; }
  #toast.show { display: block; }
  #install { position: fixed; inset: 0; z-index: 20; background: #fff; padding: 28px 24px;
             display: none; }
  #install.show { display: block; }
  #install h1 { font-size: 20px; margin: 0 0 12px; }
  #install ol { padding-left: 20px; line-height: 1.6; color: #374151; }
  #install .nota { margin-top: 18px; font-size: 13px; color: #6b7280; }
</style>
</head>
<body>
<iframe id="app" src="__APP_URL__" allow="camera *; clipboard-write *"></iframe>
<button id="bell">🔔 Activar avisos</button>
<div id="toast"></div>

<div id="install">
  <h1>Agregala a la pantalla de inicio</h1>
  <ol>
    <li>Tocá el botón <b>Compartir</b> abajo (el cuadradito con la flecha).</li>
    <li>Elegí <b>Agregar a inicio</b>.</li>
    <li>Abrila desde el ícono nuevo.</li>
  </ol>
  <p class="nota">iOS solo deja mandar notificaciones a las apps agregadas a la
  pantalla de inicio. Desde Safari no se puede.</p>
</div>

<script>
  var bell  = document.getElementById('bell');
  var toast = document.getElementById('toast');
  var standalone = window.navigator.standalone === true ||
                   window.matchMedia('(display-mode: standalone)').matches;
  var esIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

  function decir(msg, ms) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(function() { toast.classList.remove('show'); }, ms || 4000);
  }

  function b64ToU8(base64) {
    var pad = '='.repeat((4 - base64.length % 4) % 4);
    var b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(b64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  // En iOS la suscripción a push solo funciona con la app abierta desde el
  // ícono. Si entró por Safari se muestran las instrucciones y nada más.
  if (esIOS && !standalone) {
    document.getElementById('install').classList.add('show');
  }

  async function activar() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        decir('Este navegador no soporta notificaciones push', 6000); return;
      }
      var permiso = await Notification.requestPermission();
      if (permiso !== 'granted') { decir('No diste permiso para notificaciones', 5000); return; }

      var reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      var key = await (await fetch('/api/vapid')).text();
      var sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToU8(key)
        });
      }
      var r = await fetch('/api/subscribe?standalone=' + (standalone ? '1' : '0'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub)
      });
      if (!r.ok) throw new Error('El servidor rechazó la suscripción');
      bell.classList.remove('show');
      decir('Listo. De noche te voy a recordar que cierres el día.', 5000);
    } catch (e) {
      decir('No se pudo activar: ' + (e && e.message ? e.message : e), 7000);
    }
  }

  bell.addEventListener('click', activar);

  // Mostrar el botón solo si hace falta: sin permiso todavía, o con permiso
  // pero sin suscripción guardada (pasa si reinstaló la app).
  (async function() {
    if (esIOS && !standalone) return;
    if (!('serviceWorker' in navigator)) return;
    try {
      var reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (Notification.permission !== 'granted' || !sub) bell.classList.add('show');
      else fetch('/api/subscribe?standalone=' + (standalone ? '1' : '0'),
                 { method: 'POST', headers: { 'Content-Type': 'application/json' },
                   body: JSON.stringify(sub) });
    } catch (e) { bell.classList.add('show'); }
  })();
</script>
</body>
</html>`;

export const SERVICE_WORKER = `// El push viene vacío: acá se pregunta qué falta y se arma el texto.
//
// La consulta tiene timeout corto y la notificación se muestra siempre, con
// texto genérico si el servidor no contesta. iOS penaliza a las apps que
// reciben un push y no notifican, así que quedarse esperando una respuesta es
// peor que avisar de más.
function conTimeout(promesa, ms) {
  return Promise.race([
    promesa,
    new Promise(function(_, rechazar) { setTimeout(function() { rechazar(new Error('timeout')); }, ms); })
  ]);
}

self.addEventListener('push', function(event) {
  event.waitUntil((async function() {
    var titulo = '🧘 Hábitos', cuerpo = 'Cargá lo que falta del día', url = '/';
    // Acuse de recibo: deja constancia en el servidor de que el push llegó al
    // teléfono. Sin esto no hay forma de distinguir "no llegó" de "llegó y no
    // se mostró".
    try { fetch('/api/ack?e=push', { cache: 'no-store' }); } catch (e) {}
    try {
      var r = await conTimeout(fetch('/api/pending?modo=auto', { cache: 'no-store' }), 3000);
      var d = await r.json();
      if (d && d.pendingNum === 0) {
        // Igual hay que mostrar algo: iOS castiga a las apps que reciben push
        // y no notifican. Se muestra algo corto y silencioso.
        titulo = '✓ Todo cargado';
        cuerpo = d.msg || 'No falta nada';
      } else if (d) {
        titulo = d.title || titulo;
        cuerpo = d.msg || cuerpo;
      }
    } catch (e) {}
    await self.registration.showNotification(titulo, {
      body: cuerpo,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'habitos',
      renotify: true,
      data: { url: url }
    });
  })());
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil((async function() {
    var todas = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (var i = 0; i < todas.length; i++) {
      if ('focus' in todas[i]) return todas[i].focus();
    }
    if (clients.openWindow) return clients.openWindow('/');
  })());
});

self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(event) { event.waitUntil(self.clients.claim()); });
`;

export const MANIFEST = {
  name: 'Gastos y Hábitos',
  short_name: 'Gastos',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#f6f7f9',
  theme_color: '#0f766e',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
  ]
};
