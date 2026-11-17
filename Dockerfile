FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY scripts/build-client.mjs scripts/build-client.mjs
COPY frontend ./frontend
COPY src ./src
RUN npm run build:node

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node","dist/server.mjs"]
