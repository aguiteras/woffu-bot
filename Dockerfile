FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* yarn.lock* ./

RUN if [ -f yarn.lock ]; then yarn install --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci; \
    else npm install; fi

COPY . .

ENV NODE_ENV=production
ENV PORT=8001

EXPOSE 8001

CMD ["node", "index.js"]

