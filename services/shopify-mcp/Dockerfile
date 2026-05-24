FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY index.js ./index.js

ENV NODE_ENV=production
ENV SHOPIFY_MCP_PORT=8097

EXPOSE 8097

CMD ["npm", "start"]
