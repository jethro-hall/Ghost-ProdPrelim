FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY index.js ./index.js

ENV NODE_ENV=production
ENV HUBTIGER_MCP_PORT=8096

EXPOSE 8096

CMD ["npm", "start"]
