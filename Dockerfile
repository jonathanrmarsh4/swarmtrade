FROM node:20-alpine

WORKDIR /app

# Install dependencies first so this layer is cached unless package files change.
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy application source.
COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
