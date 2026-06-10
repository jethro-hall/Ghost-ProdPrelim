FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./
COPY lib ./lib
COPY config ./config

ENV NODE_ENV=production
ENV HUBTIGER_PROXY_PORT=8095
EXPOSE 8095

CMD ["node", "index.js"]
