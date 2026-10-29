# 🍻 Juntada · votación de fecha

App web mínima para que un grupo de amigos vote **qué días puede** juntarse (selección
múltiple) dentro de un rango de fechas. Gana el día más votado.

- **Link personal por persona**: cada uno entra con su link, sin usuario ni contraseña.
- **Panel `/admin`**: cargás a la gente, mandás los links por WhatsApp, ves los resultados,
  cerrás la votación y fijás la fecha final (con botón "Agregar a mi calendario").
- **Bot de WhatsApp opcional** (Baileys) para enviar códigos de acceso y links.
- Node 20 **sin dependencias**; los datos van en un único archivo `data/db.json`.

## Requisitos

- Docker con Docker Compose (recomendado), o Node.js 20+.
- Para publicarla: un dominio con HTTPS (Cloudflare Tunnel, Caddy, nginx o nginx-proxy).

## Probarla en tu máquina

```bash
git clone https://github.com/emilioSaldivar/juntada-votos.git
cd juntada-votos
cp .env.example .env          # editá ADMIN_TOKEN, fechas y título
```

En `.env`, para probar en local, poné `BASE_URL=http://localhost:3000` y un `ADMIN_TOKEN`
de al menos 12 caracteres (`openssl rand -base64 24`).

**Sin Docker y sin bot** (lo más rápido):

```bash
node server.js
```

**Con Docker** (app + bot):

```bash
openssl rand -hex 32          # pegalo en BOT_WEBHOOK_TOKEN dentro de .env
mkdir -p data bot-auth && sudo chown 1000:1000 data bot-auth && chmod 700 bot-auth
docker compose up -d --build
```

Abrí <http://localhost:3000/admin> e ingresá el `ADMIN_TOKEN`.

## Configuración (`.env`)

| Variable | Obligatoria | Qué es |
| --- | --- | --- |
| `BASE_URL` | sí | URL pública sin `/` final. Con ella se arman los links personales. |
| `ADMIN_TOKEN` | sí | Clave del panel `/admin` (mínimo 12 caracteres). |
| `PORT` | no | Puerto de la app (por defecto `3000`). |
| `EVENT_TITLE` | no | Título que ve la gente. |
| `START_DATE` / `END_DATE` | no | Rango de días votables, `YYYY-MM-DD`, inclusive. |
| `DEFAULT_COUNTRY_CODE` | no | Prefijo para números cargados sin código de país (`595` = Paraguay). |
| `COOKIE_SECURE` | no | Vacío = automático según `BASE_URL`; `true` / `false` para forzar. |
| `DOMAIN` | sólo nginx-proxy | Dominio para `VIRTUAL_HOST` y el certificado. |
| `BOT_WEBHOOK_TOKEN` | sólo con bot | Token compartido app ↔ bot (mínimo 16 caracteres). |
| `BOT_MAX_PER_HOUR` | no | Tope de mensajes por hora del bot (por defecto `60`). |
| `BOT_PAIR_PHONE` | no | Número del chip para vincular con código en vez de QR. |
| `BOT_WEBHOOK_URL` | sólo sin Docker | URL del bot; con Docker Compose ya viene fijada. |

> El texto del mensaje de invitación está en `linkMessage()` de [`server.js`](server.js).
> Cambialo por el de tu grupo.

## Desplegar en un servidor

Antes de nada, en el servidor: clonar el repo, `cp .env.example .env` y completar
`BASE_URL` con tu dominio real, `ADMIN_TOKEN` y `BOT_WEBHOOK_TOKEN`.

### Opción A · Docker Compose + tu proxy HTTPS

`docker-compose.yml` publica la app sólo en `127.0.0.1:3000`, así que no queda expuesta
directamente. Ponele HTTPS adelante con alguna de estas:

- **Cloudflare Tunnel** (sin abrir puertos): `cloudflared tunnel create juntada` y en el
  config `service: http://localhost:3000` con el hostname de tu dominio.
- **Caddy**: `juntada.midominio.com { reverse_proxy 127.0.0.1:3000 }` (HTTPS automático).
- **nginx** con certbot, `proxy_pass http://127.0.0.1:3000;`.

```bash
mkdir -p data bot-auth && sudo chown 1000:1000 data bot-auth && chmod 700 bot-auth
docker compose up -d --build
```

### Opción B · Detrás de nginx-proxy + acme-companion

Si tu servidor ya usa [nginx-proxy](https://github.com/nginx-proxy/nginx-proxy) con
`acme-companion` y una red Docker externa llamada `proxy`,
[`deploy/docker-compose.vps.yml`](deploy/docker-compose.vps.yml) no publica puertos y
toma el dominio de `DOMAIN` (más `PORT`) en el `.env` del servidor.

Para desplegar desde tu máquina por SSH:

```bash
cp .env.deploy.example .env.deploy   # host SSH, carpeta, dominio y contenedor del proxy
bash scripts/deploy-vps.sh --estado  # sólo lectura: contenedores, nginx -t y HTTPS
bash scripts/deploy-vps.sh           # copia el código, build y up
bash scripts/deploy-vps.sh --logs
```

El script **sólo reemplaza código**: nunca toca `.env`, `data/` ni `bot-auth/` del
servidor. Además corre `nginx -t` en el proxy antes y después, porque si un reload falla
nginx-proxy deja congelada la configuración de **todos** los sitios del host.

## Cómo se usa

1. Entrá a `https://tu-dominio/admin` con el `ADMIN_TOKEN`.
2. Pegá la lista de gente, una persona por línea: `Juan, 0981 123 456`.
3. Mandale a cada uno su **link personal**:
   - botón **📲 WhatsApp**: abre tu WhatsApp con el mensaje y el link ya escritos, o
   - **🤖 Bot**: si el bot está vinculado, lo envía el bot (a una persona o a todos).
4. Cada uno abre su link y marca los días que puede. Con el bot, también pueden entrar
   con su número y un código que les llega por WhatsApp.
5. Al final tildá "Votación cerrada" y elegí la fecha final: todos ven un banner con
   "Agregar a mi calendario".

## Bot de WhatsApp (opcional)

Es el contenedor `bot`, hecho con [Baileys](https://github.com/WhiskeySockets/Baileys)
6.7.24. **Sólo envía**: no lee chats, no sincroniza historial y no responde mensajes.

- **Usá un chip dedicado, nunca tu número personal.** La sesión guardada en `bot-auth/`
  da acceso completo a esa cuenta de WhatsApp: tratala como una contraseña.
- Baileys no es una API oficial de WhatsApp: mandar muchos mensajes puede hacer que
  bloqueen el número. Por eso el bot tiene un tope de `BOT_MAX_PER_HOUR` mensajes por
  hora y espera 1,2 s entre envíos. Para invitaciones masivas conviene el botón 📲.
- No publica puertos: sólo la app lo alcanza, por la red interna de Docker y con
  `BOT_WEBHOOK_TOKEN`.
- La vinculación, el QR nuevo y la desvinculación se hacen desde la tarjeta
  "Bot de WhatsApp" de `/admin`.
- Si cerrás la sesión desde el teléfono, el bot borra las credenciales y muestra un QR
  nuevo (nunca reintenta con credenciales inválidas).

## Datos, backup y reset

Todo está en `data/db.json`: personas, teléfonos, votos y sesiones. Para hacer backup,
copiá ese archivo. Para empezar una votación nueva, detené la app y borralo.

**Nunca subas al repo** `.env`, `.env.deploy`, `data/` ni `bot-auth/`: tienen tokens, datos
personales y la sesión de WhatsApp. Ya están en `.gitignore`.

## Estructura

```
server.js                     app y API (Node, sin dependencias)
public/index.html             página de votación
public/admin.html             panel de administración
bot/                          bot de WhatsApp (Baileys), sólo envío
docker-compose.yml            local, u Opción A
deploy/docker-compose.vps.yml Opción B (nginx-proxy)
scripts/deploy-vps.sh         deploy por SSH para la Opción B
```

## Contribuir

Issues y pull requests son bienvenidos. La idea es mantenerlo simple: sin dependencias
en la app y fácil de levantar en cualquier VPS.

## Licencia

[MIT](LICENSE)
