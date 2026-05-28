FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

ENV NODE_ENV=production
ENV ODOO_RPC_PORT=8097
EXPOSE 8097

CMD ["node", "index.js"]
