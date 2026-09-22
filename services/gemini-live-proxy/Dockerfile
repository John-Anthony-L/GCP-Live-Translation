FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY dist ./dist
COPY *glossary.json ./

EXPOSE 8080
CMD ["node", "dist/server.js"]
