# 🤖 Bot-ID

**Sistema activista de detección y exposición pública de bots en redes sociales**

> Sin partido. Sin patrocinador. Datos abiertos.

Bot-ID es una herramienta de transparencia digital que monitorea Bluesky buscando cuentas bot automáticamente, responde menciones analizando cuentas a pedido, y publica reportes semanales de manipulación digital.

---

## ¿Qué hace?

| Función | Descripción |
|---------|-------------|
| 📡 Escucha menciones | Cada 60 segundos revisa si alguien le pidió analizar una cuenta |
| 🔍 Scanner proactivo | Cada 6 horas escanea hashtags sensibles (política mexicana) |
| 🧮 Motor de análisis | 8 señales ponderadas que calculan probabilidad de bot (0-100) |
| 🤖 Claude AI | Genera reportes en tono activista basados en los datos |
| 📊 Reporte semanal | Cada lunes publica un análisis de la semana |
| 🗄️ Base pública | Todos los bots detectados se guardan en SQLite local |

---

## Instalación paso a paso

### 1. Requisitos previos

- [Node.js 18 o superior](https://nodejs.org)
- Una cuenta en [Bluesky](https://bsky.app) (puede ser anónima)
- Una cuenta en [Anthropic Console](https://console.anthropic.com)

### 2. Clonar el repositorio

```bash
git clone https://github.com/tu-usuario/bot-id.git
cd bot-id
```

### 3. Instalar dependencias

```bash
npm install
```

### 4. Configurar credenciales

```bash
cp .env.example .env
```

Abre `.env` con cualquier editor de texto y completa:

```env
BLUESKY_USERNAME=tu-usuario.bsky.social
BLUESKY_PASSWORD=xxxx-xxxx-xxxx-xxxx
ANTHROPIC_API_KEY=sk-ant-...
```

---

## Cómo obtener cada credencial

### Credencial 1: BLUESKY_USERNAME

Tu handle de Bluesky. Ejemplos válidos:
- `botwatch.bsky.social`
- `usuario.bsky.social`

Si no tienes cuenta, créala en [bsky.app](https://bsky.app).

---

### Credencial 2: BLUESKY_PASSWORD (App Password)

**NO uses tu contraseña principal.** Bluesky permite crear contraseñas de aplicación dedicadas.

1. Entra a [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords)
2. Haz clic en **"Add App Password"**
3. Ponle nombre: `bot-id` o el que prefieras
4. Copia el código generado (formato: `xxxx-xxxx-xxxx-xxxx`)
5. Pégalo en `BLUESKY_PASSWORD` en tu `.env`

> Si pierdes el App Password, simplemente revócalo y crea uno nuevo. Tu contraseña principal queda intacta.

---

### Credencial 3: ANTHROPIC_API_KEY

1. Ve a [console.anthropic.com](https://console.anthropic.com)
2. Crea una cuenta si no tienes (requiere tarjeta de crédito)
3. En el menú lateral, ve a **"API Keys"**
4. Haz clic en **"Create Key"**
5. Dale un nombre: `bot-id`
6. Copia la clave (formato: `sk-ant-api03-...`)
7. Pégala en `ANTHROPIC_API_KEY` en tu `.env`

> **Costo estimado**: Claude Sonnet cuesta ~$3/millón tokens de entrada y ~$15/millón de salida. Para uso moderado, el costo mensual suele ser menor a $5 USD.

---

## Iniciar el sistema

```bash
npm start
```

Verás algo como esto:

```
╔══════════════════════════════════════════════════════╗
║   🤖  B O T - I D                                   ║
║   Sistema de transparencia digital                   ║
╚══════════════════════════════════════════════════════╝

✅ Bot-ID activo
📡 Escuchando menciones... (cada 60s)
🔍 Scanner proactivo: activo (cada 6h)
📊 Próximo reporte: lunes 24 de marzo de 2026, 08:00 (hora México)
```

---

## Uso en Bluesky

Cualquier usuario puede pedir un análisis mencionando al bot:

```
@botwatch.bsky.social analiza @cuenta-sospechosa.bsky.social
```

El bot responderá en ~60 segundos con el análisis.

---

## Cómo funciona el análisis

El sistema evalúa 8 señales con pesos ponderados:

| # | Señal | Peso |
|---|-------|------|
| 1 | Ratio seguidores/seguidos | 20% |
| 2 | Edad de la cuenta vs volumen de posts | 15% |
| 3 | Frecuencia de publicación diaria | 20% |
| 4 | Perfil vacío (sin bio o sin foto) | 10% |
| 5 | Patrón sospechoso en el nombre de usuario | 5% |
| 6 | Contenido repetitivo o reposts masivos | 15% |
| 7 | Intervalos de publicación robóticos | 10% |
| 8 | Cero interacciones recibidas | 5% |

**Score resultante:**
- 🟢 0-34: BAJO — comportamiento humano
- 🟡 35-59: MEDIO — señales leves
- 🟠 60-79: ALTO — comportamiento sospechoso
- 🔴 80-100: MUY ALTO — muy probable bot

---

## Reportes semanales

Cada lunes a las 8am (hora México) se genera automáticamente un reporte en 4 formatos:

```
reports/
└── 2026-03-16/
    ├── bluesky.txt        (≤300 chars para publicar)
    ├── instagram.txt      (caption + hashtags)
    ├── twitter-hilo.txt   (hilo de 5 tweets)
    ├── substack.md        (artículo completo ~800 palabras)
    └── datos.json         (datos crudos)
```

---

## Estructura del proyecto

```
bot-id/
├── .env                    # Credenciales (no subir a GitHub)
├── .env.example            # Plantilla
├── .gitignore
├── package.json
├── index.js                # Punto de entrada
├── src/
│   ├── bluesky.js          # Cliente API Bluesky
│   ├── analyzer.js         # Motor de detección (8 señales)
│   ├── claude.js           # Integración Anthropic AI
│   ├── database.js         # SQLite
│   ├── mentions.js         # Listener de menciones
│   ├── scanner.js          # Scanner proactivo de hashtags
│   └── reporter.js         # Generador de reportes
├── reports/                # Reportes generados
└── botid.db                # Base de datos local (auto-generada)
```

---

## Despliegue en servidor (producción)

Para mantener Bot-ID corriendo 24/7, usa PM2:

```bash
npm install -g pm2
pm2 start index.js --name bot-id
pm2 startup  # Para que inicie al reiniciar el servidor
pm2 save
```

O con Docker:

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
CMD ["node", "index.js"]
```

---

## Consideraciones éticas

- Bot-ID **nunca acusa con certeza absoluta** — siempre habla de probabilidades
- Los análisis están basados en **señales medibles**, no en opinión
- Los datos son **abiertos y reproducibles**
- La herramienta no tiene afiliación política
- El objetivo es la **transparencia del debate público**, no atacar personas

---

## Licencia

MIT — Libre para copiar, modificar y desplegar tu propia instancia.
