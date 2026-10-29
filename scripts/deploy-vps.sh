#!/usr/bin/env bash
# Despliega la app en una VPS por SSH, detrás de nginx-proxy + acme-companion
# (https://github.com/nginx-proxy/nginx-proxy). Config en .env.deploy (ver .env.deploy.example).
#
# Sólo reemplaza código: NO toca .env, data/ (votos) ni bot-auth/ (sesión de WhatsApp)
# del servidor. Verifica el proxy antes y después: si `nginx -t` falla, aborta o avisa,
# porque un reload fallido congela la configuración de TODOS los sitios del proxy.
#
#   bash scripts/deploy-vps.sh            # despliega
#   bash scripts/deploy-vps.sh --estado   # sólo lee: contenedores, proxy y HTTPS
#   bash scripts/deploy-vps.sh --logs     # sigue los logs del servidor
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f .env.deploy ]] && source .env.deploy
HOST=${DEPLOY_HOST:?definí DEPLOY_HOST en .env.deploy (alias de ~/.ssh/config o usuario@host)}
DIR=${DEPLOY_DIR:-apps/juntada}
DOMAIN=${DEPLOY_DOMAIN:?definí DEPLOY_DOMAIN en .env.deploy}
PROXY=${PROXY_CONTAINER:-nginx-proxy}

borde() {
  ssh -o BatchMode=yes "$HOST" "
    docker exec $PROXY nginx -t >/dev/null 2>&1 && echo 'nginx -t: OK' || { echo 'nginx -t: FALLA'; exit 1; }
    n=\$(docker exec $PROXY grep -c 'Start of configuration add by letsencrypt' /etc/nginx/vhost.d/default || true)
    [ \"\$n\" = 0 ] && echo 'vhost.d/default: limpio' || { echo 'vhost.d/default: tiene el bloque ACME (duplicate location)'; exit 1; }"
}

estado() {
  ssh -o BatchMode=yes "$HOST" "cd ~/$DIR && docker compose ps --format 'table {{.Service}}\t{{.Status}}'"
  borde
  echo "https://$DOMAIN → $(curl -s -m 10 -o /dev/null -w '%{http_code}' "https://$DOMAIN/")"
}

case "${1:-}" in
  --estado) estado; exit 0 ;;
  --logs) exec ssh "$HOST" "cd ~/$DIR && docker compose logs -f --tail 50" ;;
esac

echo "== 1/4 proxy antes de desplegar"
borde || { echo "El proxy ya está mal: no despliego encima. Revisar antes."; exit 1; }

echo "== 2/4 copiando código (sin .env, data ni bot-auth)"
ssh -o BatchMode=yes "$HOST" "mkdir -p ~/$DIR"
tar czf - server.js Dockerfile .dockerignore public README.md \
  bot/index.js bot/package.json bot/package-lock.json bot/Dockerfile bot/.dockerignore \
  | ssh -o BatchMode=yes "$HOST" "tar xzf - -C ~/$DIR"
scp -q -o BatchMode=yes deploy/docker-compose.vps.yml "$HOST:$DIR/docker-compose.yml"
ssh -o BatchMode=yes "$HOST" "test -f ~/$DIR/.env" \
  || { echo "Falta ~/$DIR/.env en el servidor (copiá .env.example y completalo). No levanto nada."; exit 1; }

echo "== 3/4 build y up"
ssh -o BatchMode=yes "$HOST" "cd ~/$DIR && docker compose config --quiet && docker compose up -d --build 2>&1 | grep -iE 'error|Started|Recreated|Running' || true"
sleep 8

echo "== 4/4 verificación"
estado
