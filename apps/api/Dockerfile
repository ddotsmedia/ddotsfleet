FROM node:26-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@12.11.2
ENV HUSKY=0
COPY . .
RUN pnpm install --frozen-lockfile --filter @fleetos/api... && pnpm --filter @fleetos/api build

FROM node:26-alpine AS run
WORKDIR /app
ENV NODE_ENV=production PORT=4000
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/package.json ./
COPY --from=build /repo/node_modules ./node_modules
USER node
EXPOSE 4000
HEALTHCHECK CMD wget -qO- http://127.0.0.1:4000/health/live || exit 1
CMD ["node", "dist/main.js"]
