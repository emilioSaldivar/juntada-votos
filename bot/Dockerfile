FROM node:20-alpine AS deps
RUN apk add --no-cache git \
 && git config --global url."https://github.com/".insteadOf ssh://git@github.com/ \
 && git config --global url."https://github.com/".insteadOf git@github.com:
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY index.js package.json ./
ENV NODE_ENV=production AUTH_DIR=/app/auth
USER node
CMD ["node", "index.js"]
