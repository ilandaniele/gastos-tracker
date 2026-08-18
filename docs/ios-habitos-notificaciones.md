# Notificaciones de hábitos en iPhone

La idea: de noche el teléfono insiste hasta que cierres el día, y a la mañana
te pregunta una sola cosa (a qué hora te levantaste). Si ya cargaste, no
molesta más.

Son **dos atajos** y **cinco automatizaciones**. Se hace una sola vez.

URL base (la misma de la app):

```
https://script.google.com/macros/s/AKfycbw_Nom1eonYjrZvHIAixp6YzEhKfYqGjl5qfUrddtbEm8zJLIviB1oULPWcP2GH9VRUZA/exec
```

---

## Atajo 1 — "Cerrar el día"

Atajos → **+** → nombre `Cerrar el día`.

### 1. Get Contents of URL

```
<URL>?action=habitPending&modo=noche
```

Devuelve un JSON con `pendingNum` (1 = falta algo, 0 = está todo),
`date` (el día que hay que cerrar) y `msg` (qué falta).

### 2. Get Dictionary Value → `pendingNum`
Guardalo en una variable `pend`.

### 3. Get Dictionary Value → `date`
Guardalo en una variable `dia`. **Importante**: después de medianoche el día
que se cierra es el de ayer, y esta fecha ya viene corregida. No uses "Fecha
de hoy".

### 4. If — `pend` **is** `1`

Adentro del If:

**4.1 Ask for Input** — `¿A qué hora te acostaste?` → tipo **Hora**
→ Set Variable `acoste`
(Formatear como `HH:mm`: usá **Format Date** con formato personalizado `HH:mm`.)

**4.2 Choose from Menu** — `¿Fuiste al gimnasio?`
- `Sí` → Set Variable `ejer` = `Gimnasio`
- `No` → Set Variable `ejer` = (vacío)

**4.3 Choose from Menu** — `¿Meditaste?`
- `Sí` → Set Variable `med` = `si`
- `No` → Set Variable `med` = `no`

**4.4 Choose from Menu** — `¿Leíste o estudiaste?`
- `Sí` → Set Variable `lei` = `si`
- `No` → Set Variable `lei` = `no`

**4.5 Ask for Input** — `¿Cuántas veces?` → tipo **Número** → variable `mast`

**4.6 Get Contents of URL** — una sola llamada guarda todo:

```
<URL>?action=habitDay&date=[dia]&acoste=[acoste]&ejercicio=[ejer]&medite=[med]&lei=[lei]&mast=[mast]
```

**4.7 Show Notification** — `✓ Día cerrado`

### 5. Otherwise
**Show Notification** — `Ya está todo cargado` (o dejalo vacío para que no
diga nada).

---

## Atajo 2 — "Me levanté"

Igual pero más corto:

1. **Get Contents of URL** → `<URL>?action=habitPending&modo=manana`
2. **Get Dictionary Value** → `pendingNum` → variable `pend`
3. **If** `pend` is `1`:
   - **Ask for Input** → `¿A qué hora te levantaste?` (Hora, formato `HH:mm`)
   - **Get Contents of URL** → `<URL>?action=habitDay&levante=[hora]`
   - **Show Notification** → `✓ Anotado`

No hace falta mandar la fecha: a la mañana el día es el de hoy.

---

## Las automatizaciones

Atajos → pestaña **Automatización** → **+** → **Hora del día**.

Una por cada horario (iOS no repite por hora, hay que crear una por cada uno):

| Hora  | Atajo          |
|-------|----------------|
| 23:00 | Cerrar el día  |
| 00:00 | Cerrar el día  |
| 01:00 | Cerrar el día  |
| 02:00 | Cerrar el día  |
| 09:00 | Me levanté     |

En todas: **Repetir: Diariamente** y **Ejecutar inmediatamente** activado
(así te llega la notificación sin tener que confirmar nada).

Si ya cargaste, el atajo corta en el `If` y no pregunta nada: la insistencia
se apaga sola.

---

## Probar sin esperar a la noche

Corré el atajo a mano. Para ver qué contesta el servidor, pegá esto en el
navegador:

```
<URL>?action=habitPending&modo=noche
```

- `pendingNum: 1` → falta algo (lo dice en `msg` y en `faltantes`)
- `pendingNum: 0` → está todo cerrado

---

## Qué pregunta cada modo

**modo=noche** (de 23 a 3 AM). Pide lo que se contesta al final del día:

- a qué hora te acostaste
- si fuiste al gimnasio
- si meditaste
- si leíste
- el contador
- el avance del día

No pide la hora de levantarte: esa se contesta al otro día.

**modo=manana**. Solo la hora de levantarte, que es lo que cierra el cálculo
de sueño de esa noche.

**Sin modo** (el de siempre, para el día). Agua, comidas, trabajo y avance,
entre las 9 y las 23.

---

## Parámetros que acepta `habitDay`

Todos opcionales, se manda solo lo que se quiere escribir:

| Parámetro      | Ejemplo      | Qué hace                                  |
|----------------|--------------|-------------------------------------------|
| `date`         | `2026-08-18` | Qué día. Si falta, hoy.                   |
| `levante`      | `07:15`      | Hora de levantarse                        |
| `acoste`       | `23:40`      | Hora de acostarse (calcula las hs sueño)  |
| `ejercicio`    | `Gimnasio`   | Qué hiciste                               |
| `ejercicioMin` | `60`         | Minutos                                   |
| `medite`       | `si` / `no`  | Se guarda como Sí/No                      |
| `mediteMin`    | `15`         | Minutos meditados                         |
| `lei`          | `si` / `no`  | Leí o estudié                             |
| `mast`         | `1`          | Total del día                             |
| `mastDelta`    | `1`          | Suma al que ya había                      |
| `trabajo`      | `6.5`        | Horas trabajadas                          |
| `avance`       | `4`          | Del 1 al 5                                |
| `animo`        | `3`          | Del 1 al 5                                |
| `notas`        | `texto`      | Notas del día                             |
