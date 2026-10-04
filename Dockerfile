FROM node:22-alpine
WORKDIR /app
COPY package.json server.js index.html privacy.html terms.html ./
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
