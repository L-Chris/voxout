FROM node:25-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY frontend ./frontend
RUN npm run build

FROM node:25-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4177
ENV TTS_AUDIO_DIR=/app/audio

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public

RUN mkdir -p /app/audio

EXPOSE 4177

CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ]; then node prisma/rename-snake-case-columns.mjs && npx prisma db push --accept-data-loss; fi; node dist/server.js"]
