# iOS Shortcut: Agregar Gasto

## Setup (5 min, una sola vez)

1. Abrí app **Shortcuts** (Atajos) en iPhone
2. Tap **+** arriba derecha → nuevo shortcut
3. Nombre: `Agregar Gasto`

## Acciones del Shortcut (agregar en orden)

### 1. Ask for Input — Ítem
- Action: **Ask for Input**
- Prompt: `Ítem`
- Input type: Text

### 2. Save as Variable — `item`
- Action: **Set Variable** → Name `item`, Value: resultado anterior

### 3. Ask for Input — Monto
- Prompt: `Monto`
- Input type: Number

### 4. Set Variable `amount`

### 5. Choose from Menu — Medio de pago
- Action: **Choose from Menu**
- Prompt: `Medio de pago`
- Items:
  - Crédito OCA
  - Crédito Itaú UYU
  - Crédito Itaú USD
  - Débito UYU
  - Débito USD

Para cada opción, agregá un bloque que setea variables `card` y `currency`:

- "Crédito OCA" → `card`=Crédito OCA, `currency`=UYU
- "Crédito Itaú UYU" → `card`=Crédito Itaú UYU, `currency`=UYU
- "Crédito Itaú USD" → `card`=Crédito Itaú USD, `currency`=USD
- "Débito UYU" → `card`=Débito UYU, `currency`=UYU
- "Débito USD" → `card`=Débito USD, `currency`=USD

### 6. Choose from Menu — Categoría
- Items: Transporte, Comida, Bebida/Bar, Salud, Suscripciones, Entretenimiento, Hogar, Limpieza, Ropa, Regalos, Gimnasio, Servicios, Otros
- Save selected → variable `category`

### 7. Current Date
- Action: **Date** → Current Date
- Format: ISO 8601 (YYYY-MM-DD)
- Save → variable `date`

### 8. Get Contents of URL
- Action: **Get Contents of URL**
- URL: 
```
https://script.google.com/macros/s/AKfycbzmN4924Cvy3LHES6vHjGvy_QoOGU8v4KNCTIztfoTTDB-XAuKd2KWqQScnZgFQw1Bdfw/exec?item=[item]&amount=[amount]&currency=[currency]&card=[card]&category=[category]&date=[date]
```
Reemplazá `[var]` arrastrando las variables al campo URL.

- Method: GET

### 9. Show Result
- Action: **Show Result** → muestra el JSON de respuesta

## Uso

### Desde Home Screen
- En la app Shortcuts, tap los 3 puntos del shortcut → **Add to Home Screen** → ícono en pantalla principal
- Tap el ícono → llena form → confirma → escribe Sheet

### Desde Siri
- "Hey Siri, agregar gasto" → activa shortcut

### Desde Share Sheet
- Activado por default. Útil si querés agregar info que copiaste.

## Cotización auto (opcional)

Si querés que el shortcut también busque BCU rate del día:

1. Antes del "Get Contents of URL", agregá:
2. **Get Contents of URL** apuntando a un endpoint de cotización (ej: `https://dolar.melo.uy/api/uy/usd/last`)
3. **Get Dictionary Value** → key `value` o similar
4. Save → variable `cotizacion`
5. Agregá `&cotizacion=[cotizacion]` al final del URL del webhook

## Tips

- Para `/bus` rápido: hacé un shortcut SEPARADO "Bus 52" sin inputs, hardcoded item=Bus amount=52 card="Crédito OCA" category=Transporte. Tap = instant write.
- Mismo patrón para `/uber N` con solo prompt de monto.
- Podés tener varios shortcuts en Home Screen (Bus, Uber, Cabify, Disco, Claude) para casos frecuentes.
