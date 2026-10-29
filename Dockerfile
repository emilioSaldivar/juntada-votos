FROM node:20-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/app/data
USER node
EXPOSE 38017
CMD ["node", "server.js"]
